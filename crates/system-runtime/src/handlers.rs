//! 工具执行：根据方法名把 JSON-RPC params 落到各文件/搜索/变更/Shell 模块。
//! 写/执行类操作先经 grant（审批凭据）校验；异步操作（shell）交给工作线程回包，
//! 避免阻塞协议主循环。git 全部方法见 handlers_git。

use serde_json::{json, Value};

use crate::grant::{require_grant, require_network_approval};
use crate::params::{
    EditParams, GlobParams, GrantPathParams, GrepParams, ListParams, MoveParams, OperationSource,
    ReadParams, ShellParams, WriteParams,
};
use crate::protocol::{emit, error_response, ok_response, running_shells, workspace_root, OpError};
use crate::{files, mutate, paths, sandbox, search, shell};

pub fn handle_file_read(params: Value) -> Result<Value, OpError> {
    let params: ReadParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let result = files::read(&root, &params.path, params.offset, params.limit)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "content": result.content,
        "sizeBytes": result.size_bytes,
        "totalLines": result.total_lines,
        "offset": result.offset,
        "modifiedMs": result.modified_ms,
        "contentSha256": result.content_sha256,
        "readComplete": result.read_complete,
        // revision（mtime+size+sha256 嵌套凭据）：与 files.rs L162-164 的约定对齐——
        // 由 Rust 侧在 file.read 成功后统一计算并返回。完整读取（readComplete）
        // 的凭据可用于 file.write 覆盖校验；分页窗口凭据只用于 file.edit
        // 陈旧检测（TS 层按 readComplete 分档）。此前缺失此字段会切断
        // "先读后改"链路：extractRevision 提取不到 → 不登记 → edit/write 必拒。
        "revision": {
            "modifiedMs": result.modified_ms,
            "sizeBytes": result.size_bytes,
            "sha256": result.content_sha256,
        },
    }))
}

pub fn handle_file_list(params: Value) -> Result<Value, OpError> {
    let params: ListParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let result = files::list(
        &root,
        &params.path,
        params.recursive.unwrap_or(false),
        params.offset,
        params.limit,
    )
    .map_err(|message| OpError::new("file_error", message))?;
    serde_json::to_value(result).map_err(|error| OpError::new("internal", error.to_string()))
}

pub fn handle_file_glob(params: Value) -> Result<Value, OpError> {
    let params: GlobParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = search::glob_search(
        &root,
        &params.pattern,
        params.offset,
        params.limit.unwrap_or(search::DEFAULT_GLOB_LIMIT),
    )
    .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "matches": outcome.matches,
        "truncated": outcome.truncated,
    }))
}

pub fn handle_file_grep(params: Value) -> Result<Value, OpError> {
    let params: GrepParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = search::grep_search(
        &root,
        &params.text,
        params.glob.as_deref(),
        params.ignore_case.unwrap_or(false),
        params.context.unwrap_or(0),
        params.max_results.unwrap_or(search::DEFAULT_GREP_LIMIT),
    )
    .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "matches": outcome.matches,
        "truncated": outcome.truncated,
    }))
}

pub fn handle_file_write(params: Value) -> Result<Value, OpError> {
    let params: WriteParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    // 授权来源显式化：agent 必须携带通过校验的审批凭据；ui（编辑器保存）
    // 是用户直接动作、免凭据。缺省按 agent 处理，保证既有调用方语义不变。
    if params.source != Some(OperationSource::Ui) {
        let grant = params.grant.as_deref().ok_or_else(|| {
            OpError::new(
                "invalid_grant",
                "file.write requires an approval grant for agent operations".to_string(),
            )
        })?;
        require_grant(grant, &params.workspace_root, "file.write")?;
    }
    let root = workspace_root(&params.workspace_root)?;
    let outcome = files::write(&root, &params.path, &params.content, params.revision)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "writtenBytes": outcome.written_bytes,
        "modifiedMs": outcome.modified_ms,
        "revision": {
            "modifiedMs": outcome.revision.modified_ms,
            "sizeBytes": outcome.revision.size_bytes,
            "sha256": outcome.revision.sha256,
        },
        "changedFiles": [{ "path": params.path, "action": if outcome.created { "created" } else { "modified" } }],
    }))
}

pub fn handle_file_edit(params: Value) -> Result<Value, OpError> {
    let params: EditParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.edit")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::edit(
        &root,
        &params.path,
        &params.old_text,
        &params.new_text,
        params.expected_count,
        params.revision,
    )
    .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "replacedCount": outcome.replaced_count,
        "sizeBytes": outcome.size_bytes,
        "modifiedMs": outcome.modified_ms,
        "revision": {
            "modifiedMs": outcome.revision.modified_ms,
            "sizeBytes": outcome.revision.size_bytes,
            "sha256": outcome.revision.sha256,
        },
        "changedFiles": outcome.changed_files,
    }))
}

pub fn handle_file_delete(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.delete")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::delete(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "kind": outcome.kind, "changedFiles": outcome.changed_files }))
}

pub fn handle_file_move(params: Value) -> Result<Value, OpError> {
    let params: MoveParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.move")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::move_path(&root, &params.from, &params.to)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "from": outcome.from, "to": outcome.to, "changedFiles": outcome.changed_files }))
}

pub fn handle_file_mkdir(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.mkdir")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::mkdir(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "path": outcome.path, "changedFiles": outcome.changed_files }))
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
    require_grant(&params.grant, &params.workspace_root, "shell.execute")?;
    let allow_network = params.allow_network.unwrap_or(false);
    if allow_network {
        require_network_approval(&params.grant)?;
    }
    let root = workspace_root(&params.workspace_root)?;
    let cwd_relative = params.cwd.as_deref().unwrap_or(".");
    let cwd = paths::resolve_in_workspace(&root, cwd_relative)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(shell::DEFAULT_TIMEOUT_MS)
        .min(shell::MAX_TIMEOUT_MS);
    let request_id = shell_request_id(&id)?;
    let request = sandbox::SandboxRequest {
        command: params.command,
        cwd,
        timeout_ms,
        allow_network,
        writable_roots: vec![root, sandbox::sandbox_temp_dir()],
    };
    std::thread::spawn(move || {
        let provider = sandbox::provider();
        let sandbox_meta = json!({
            "active": provider.id() != "none",
            "provider": provider.id(),
        });
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

pub fn handle_terminal_spawn(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_spawn(params)
}
pub fn handle_terminal_attach(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_attach(params)
}
pub fn handle_terminal_write(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_write(params)
}
pub fn handle_terminal_resize(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_resize(params)
}
pub fn handle_terminal_ack(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_ack(params)
}
pub fn handle_terminal_close(params: Value) -> Result<Value, OpError> {
    crate::terminal::service::handle_close(params)
}

#[cfg(test)]
mod file_write_source_tests {
    use super::*;
    use std::env::temp_dir;
    use std::fs;

    struct Sandbox {
        root: std::path::PathBuf,
    }
    impl Sandbox {
        fn new(tag: &str) -> Self {
            let root = temp_dir().join(format!("reflexion-wsrc-{}-{}", tag, std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Sandbox { root }
        }
        fn root_str(&self) -> String {
            self.root.to_str().unwrap().to_string()
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn ui_source_writes_without_grant() {
        let sandbox = Sandbox::new("ui");
        let result = handle_file_write(json!({
            "workspaceRoot": sandbox.root_str(),
            "path": "saved.txt",
            "content": "from editor",
            "source": "ui",
        }));
        assert!(
            result.is_ok(),
            "ui write must not require grant: {:?}",
            result
        );
        assert_eq!(
            fs::read_to_string(sandbox.root.join("saved.txt")).unwrap(),
            "from editor"
        );
    }

    #[test]
    fn agent_and_default_source_still_require_grant() {
        let sandbox = Sandbox::new("agent");
        let missing = handle_file_write(json!({
            "workspaceRoot": sandbox.root_str(), "path": "a.txt", "content": "x",
        }));
        assert_eq!(missing.unwrap_err().code, "invalid_grant");
        let explicit_agent = handle_file_write(json!({
            "workspaceRoot": sandbox.root_str(), "path": "a.txt", "content": "x", "source": "agent",
        }));
        assert_eq!(explicit_agent.unwrap_err().code, "invalid_grant");
    }

    #[test]
    fn ui_source_still_denies_blind_overwrite() {
        let sandbox = Sandbox::new("blind");
        fs::write(sandbox.root.join("note.txt"), b"on disk").unwrap();
        let result = handle_file_write(json!({
            "workspaceRoot": sandbox.root_str(), "path": "note.txt", "content": "stomp", "source": "ui",
        }));
        let error = result.unwrap_err();
        assert_eq!(error.code, "file_error");
        assert!(error.message.contains("without a fresh full read"));
        // 丢更新保护与授权来源无关：盘上内容未被覆盖。
        assert_eq!(
            fs::read_to_string(sandbox.root.join("note.txt")).unwrap(),
            "on disk"
        );
    }
}
