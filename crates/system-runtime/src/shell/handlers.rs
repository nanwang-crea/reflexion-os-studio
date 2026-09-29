use crate::filesystem::paths;
use crate::grant::{normalize_relative, require_grant, require_network_approval};
use crate::params::ShellParams;
use crate::protocol::{emit, error_response, ok_response, running_shells, workspace_root, OpError};
use crate::sandbox::escalation::resolve_escalation_roots;
use crate::{sandbox, shell};
use serde_json::{json, Value};
use std::path::PathBuf;

fn digest_path(raw: &str) -> Result<String, OpError> {
    normalize_relative(raw).ok_or_else(|| {
        OpError::new(
            "path_outside_workspace",
            "cwd must be workspace-relative".into(),
        )
    })
}

fn shell_request_id(id: &Value) -> Result<String, OpError> {
    match id {
        Value::String(value) if !value.is_empty() => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err(OpError::new(
            "invalid_request",
            "shell request requires an id".to_string(),
        )),
    }
}

pub fn handle_shell_execute(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: ShellParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let cwd_relative = params.cwd.as_deref().unwrap_or(".").to_string();
    // grant 与当前实际命令逐字段绑定：command + 规范化 cwd
    // （sandbox/network 两段由 require_grant 从 grant 自身补齐）。
    let facts = require_grant(
        &params.grant,
        &params.workspace_root,
        "shell.execute",
        &[params.command.clone(), digest_path(&cwd_relative)?],
    )?;
    let allow_network = params.allow_network.unwrap_or(false);
    if allow_network {
        require_network_approval(&params.grant)?;
    }
    // 沙箱档位来自已复核 grant 的 sandbox 字段（请求侧无法自行声明更宽档位）。
    let access = sandbox::SandboxAccess::from_grant(&facts.sandbox);
    // Danger 租约语义包含网络（启用时已向用户声明"联网不再单独审批"）；
    // grant 仍显式携带 sandboxNetwork 审计字段。
    let allow_network = allow_network || access == sandbox::SandboxAccess::Danger;
    let root = workspace_root(&params.workspace_root)?;
    let cwd = paths::resolve_in_workspace(&root, &cwd_relative)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(shell::DEFAULT_TIMEOUT_MS)
        .min(shell::MAX_TIMEOUT_MS);
    let request_id = shell_request_id(&id)?;
    // 按档位装配可写根：read-only 仅沙盒临时目录；workspace-write +工作区根；
    // escalated 再并入已复核的提权根（根集合本身由 grant 携带并经 digest 绑定）。
    let temp = sandbox::sandbox_temp_dir();
    let mut writable_roots: Vec<PathBuf> = match access {
        sandbox::SandboxAccess::ReadOnly => vec![temp],
        _ => vec![root.clone(), temp],
    };
    if access == sandbox::SandboxAccess::Escalated {
        let extra = resolve_escalation_roots(&facts.escalation_roots, sandbox::provider().id())?;
        if extra
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            != facts.escalation_roots
        {
            return Err(OpError::new(
                "approval_subject_mismatch",
                "Approved paths changed; request approval again".into(),
            ));
        }
        writable_roots.extend(extra);
    }
    // 能力门禁：provider 无法可靠应用所选档位时 fail-closed，绝不无沙箱执行。
    let provider = sandbox::provider();
    if !provider.supports_access(access) {
        return Err(OpError::new(
            "sandbox_policy_unavailable",
            format!(
                "sandbox provider {} cannot enforce requested access {}",
                provider.id(),
                access.as_str()
            ),
        ));
    }
    let sandbox_meta = json!({
        "active": provider.id() != "none",
        "provider": provider.id(),
        "access": access.as_str(),
        "grantSource": facts.source,
    });
    let request = sandbox::SandboxRequest {
        command: params.command,
        cwd,
        timeout_ms,
        allow_network,
        access,
        writable_roots,
    };
    std::thread::spawn(move || {
        let provider = sandbox::provider();
        // 沙盒临时目录必须在 provider 渲染前落盘：macOS profile_path 规范化要求
        // 命中真实祖先链，Linux bwrap 的 FIXED_TMP alias 挂载看 host 可见性
        // （缺失 dest 在 ro 父挂载下 mkdir 会 EROFS）。Windows exec_direct 的
        // launch.rs 自建同款目录，create_dir_all 幂等不受影响。
        let temp = sandbox::sandbox_temp_dir();
        let outcome = match std::fs::create_dir_all(&temp) {
            // 线程闭包非 Result 上下文，禁止 `?`——match 产出 Err 走统一上报。
            Err(error) => Err(format!("sandbox temp dir create failed: {error}")),
            Ok(()) => match provider.exec_direct(&request, &|pid| {
                let _ = running_shells().lock().map(|mut shells| {
                    shells.insert(request_id.clone(), pid);
                });
            }) {
                Some(result) => result,
                None => match provider.wrap(&request) {
                    // 包装路径：TMPDIR 指到沙盒临时目录（与 Windows 轮 TMP/TEMP 重定向
                    // 同语义；该目录已在 request.writable_roots 白名单里）。bwrap argv 内的
                    // --setenv 是沙箱子进程视角的第二重权威覆盖，两者并存互不冲突。
                    Some(argv) => shell::execute_argv(
                        &argv,
                        &[("TMPDIR", temp.display().to_string())],
                        &request.cwd,
                        request.timeout_ms,
                        &|pid| {
                            let _ = running_shells().lock().map(|mut shells| {
                                shells.insert(request_id.clone(), pid);
                            });
                        },
                    ),
                    None => {
                        shell::execute(&request.command, &request.cwd, request.timeout_ms, &|pid| {
                            let _ = running_shells().lock().map(|mut shells| {
                                shells.insert(request_id.clone(), pid);
                            });
                        })
                    }
                },
            },
        };
        let _ = running_shells().lock().map(|mut shells| {
            shells.remove(&request_id);
        });
        match outcome {
            Ok(outcome) => emit(ok_response(
                id,
                json!({
                    "exitCode": outcome.exit_code,
                    "stdout": outcome.stdout,
                    "stderr": outcome.stderr,
                    "timedOut": outcome.timed_out,
                    "truncated": outcome.truncated,
                    "sandbox": sandbox_meta,
                }),
            )),
            Err(message) => emit(error_response(
                id,
                -32000,
                &message,
                Some(json!({ "code": "execution_failed" })),
            )),
        }
    });
    // 哨兵：回包由完成线程异步发出。
    Ok((Value::Null, false))
}

pub fn handle_cancel(params: &Value) {
    let request_id = params.get("requestId").and_then(|value| match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    });
    if let Some(request_id) = request_id {
        if let Ok(mut shells) = running_shells().lock() {
            if let Some(pid) = shells.remove(&request_id) {
                eprintln!("cancelling shell request {request_id} (pid {pid})");
                shell::kill_tree(pid);
            }
        }
    }
}
