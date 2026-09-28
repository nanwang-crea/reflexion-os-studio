//! 工具执行：根据方法名把 JSON-RPC params 落到各文件/搜索/变更/Shell 模块。
//! 写/执行类操作先经 grant（审批凭据）校验；异步操作（shell）交给工作线程回包，
//! 避免阻塞协议主循环。git 全部方法见 handlers_git。

use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::filesystem::{files, mutate, paths, search, upload};
use crate::grant::{normalize_relative, require_grant, require_network_approval};
use crate::params::{
    BinaryReadParams, EditParams, GlobParams, GrantPathParams, GrepParams, ListParams, MoveParams,
    OperationSource, ReadParams, ShellParams, StreamWriteParams, UnwatchParams, WatchParams,
    WriteParams,
};
use crate::protocol::{emit, error_response, ok_response, running_shells, workspace_root, OpError};
use crate::{sandbox, shell};

fn file_error(message: String) -> OpError {
    let code = if message.contains("changed since last read")
        || message.contains("changed since upload began")
    {
        "stale_revision"
    } else if message.contains("upload offset mismatch") {
        "upload_offset_mismatch"
    } else if message.contains("sha256 mismatch") {
        "upload_integrity_error"
    } else if message.contains("upload not found") || message.contains("staging file not found") {
        "upload_not_found"
    } else if message.contains("upload checkpoint") || message.contains("staging length") {
        "upload_checkpoint_error"
    } else if message.contains("not found") {
        "file_not_found"
    } else if message.contains("not valid UTF-8") {
        "not_utf8"
    } else if message.contains("too large") || message.contains("exceeds") {
        "file_too_large"
    } else if message.contains("overlap") {
        "overlapping_edits"
    } else if message.contains("expectedCount") || message.contains("expectedText") {
        "edit_mismatch"
    } else {
        "file_error"
    };
    OpError::new(code, message)
}

/// digest 资源部分：与 TS Runtime 审批前同一规范化算法；非法路径（绝对/`..`）
/// 不可能有匹配 digest——按工作区边界违规拒绝。
fn digest_path(raw: &str) -> Result<String, OpError> {
    normalize_relative(raw).ok_or_else(|| {
        OpError::new(
            "path_outside_workspace",
            format!("grant-bound path is not workspace-relative: {raw}"),
        )
    })
}

pub fn handle_file_read(params: Value) -> Result<Value, OpError> {
    let params: ReadParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let result =
        files::read(&root, &params.path, params.offset, params.limit).map_err(file_error)?;
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

pub fn handle_file_read_binary(params: Value) -> Result<Value, OpError> {
    let params: BinaryReadParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let bytes = files::read_binary(&root, &params.path).map_err(file_error)?;
    Ok(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "sizeBytes": bytes.len(),
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
    .map_err(file_error)?;
    serde_json::to_value(result).map_err(|error| OpError::new("internal", error.to_string()))
}

pub fn handle_file_watch(params: Value) -> Result<Value, OpError> {
    let params: WatchParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    crate::watcher::watch(&root, &params.path, &params.watch_id)
        .map_err(|message| OpError::new("watch_error", message))?;
    Ok(json!({ "watchId": params.watch_id }))
}

pub fn handle_file_unwatch(params: Value) -> Result<Value, OpError> {
    let params: UnwatchParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    Ok(json!({ "removed": crate::watcher::unwatch(&params.watch_id) }))
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
    .map_err(file_error)?;
    Ok(json!({
        "matches": outcome.matches,
        "truncated": outcome.truncated,
        "nextOffset": outcome.next_offset,
        "scanTruncated": outcome.scan_truncated,
        "scannedFiles": outcome.scanned_files,
        "actualGlob": params.pattern,
        "ignoreCase": false,
        "truncationReason": if outcome.scan_truncated { "workspace_walk_limit" } else if outcome.truncated { "page_limit" } else { "none" },
    }))
}

pub fn handle_file_grep(params: Value) -> Result<Value, OpError> {
    let params: GrepParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let pattern = resolve_grep_pattern(params.pattern.as_deref(), params.text.as_deref())?;
    let outcome = search::grep_search_with_mode(
        &root,
        pattern,
        params.glob.as_deref(),
        params.ignore_case.unwrap_or(false),
        params.literal.unwrap_or(false),
        params.context.unwrap_or(0),
        params.max_results.unwrap_or(search::DEFAULT_GREP_LIMIT),
        params.offset,
    )
    .map_err(file_error)?;
    Ok(json!({
        "matches": outcome.matches,
        "truncated": outcome.truncated,
        "nextOffset": outcome.next_offset,
        "scanTruncated": outcome.scan_truncated,
        "scannedFiles": outcome.scanned_files,
        "actualGlob": params.glob,
        "ignoreCase": params.ignore_case.unwrap_or(false),
        "truncationReason": if outcome.scan_truncated { "workspace_walk_limit" } else if outcome.truncated { "page_limit" } else { "none" },
    }))
}

/// 新 pattern 与旧 text 至少一个非空；两者都非空且不相等时拒绝，避免静默选错搜索内容。
fn resolve_grep_pattern<'a>(
    pattern: Option<&'a str>,
    text: Option<&'a str>,
) -> Result<&'a str, OpError> {
    let usable = |value: Option<&'a str>| value.filter(|item: &&str| !item.trim().is_empty());
    match (usable(pattern), usable(text)) {
        (Some(pattern), Some(text)) if pattern != text => Err(OpError::new(
            "invalid_request",
            "pattern and text differ; pass only one search expression".to_string(),
        )),
        (Some(pattern), _) => Ok(pattern),
        (None, Some(text)) => Ok(text),
        (None, None) => Err(OpError::new(
            "invalid_request",
            "pattern is required".to_string(),
        )),
    }
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
        require_grant(
            grant,
            &params.workspace_root,
            "file.write",
            &[digest_path(&params.path)?],
        )?;
    }
    let root = workspace_root(&params.workspace_root)?;
    let outcome =
        files::write(&root, &params.path, &params.content, params.revision).map_err(file_error)?;
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

pub fn handle_file_write_stream(params: Value) -> Result<Value, OpError> {
    let params: StreamWriteParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.write_stream",
        &[digest_path(&params.path)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    match params.action.as_str() {
        "begin" => serde_json::to_value(
            upload::begin(&root, &params.path, params.revision).map_err(file_error)?,
        )
        .map_err(|error| OpError::new("internal", error.to_string())),
        "append" => {
            let upload_id = required_upload_field(params.upload_id, "uploadId")?;
            let content = required_upload_field(params.content, "content")?;
            let chunk_sha256 = required_upload_field(params.chunk_sha256, "chunkSha256")?;
            let offset = params.offset.ok_or_else(|| {
                OpError::new(
                    "invalid_request",
                    "offset is required for append".to_string(),
                )
            })?;
            serde_json::to_value(
                upload::append(
                    &root,
                    &params.path,
                    &upload_id,
                    offset,
                    content.as_bytes(),
                    &chunk_sha256,
                )
                .map_err(file_error)?,
            )
            .map_err(|error| OpError::new("internal", error.to_string()))
        }
        "commit" => {
            let upload_id = required_upload_field(params.upload_id, "uploadId")?;
            let outcome = upload::commit(
                &root,
                &params.path,
                &upload_id,
                params.expected_size,
                params.expected_sha256.as_deref(),
            )
            .map_err(file_error)?;
            Ok(json!({
                "writtenBytes": outcome.written_bytes,
                "modifiedMs": outcome.modified_ms,
                "revision": outcome.revision,
                "changedFiles": [{ "path": params.path, "action": if outcome.created { "created" } else { "modified" } }],
            }))
        }
        "abort" => {
            let upload_id = required_upload_field(params.upload_id, "uploadId")?;
            upload::abort(&root, &params.path, &upload_id).map_err(file_error)?;
            Ok(json!({ "aborted": true }))
        }
        _ => Err(OpError::new(
            "invalid_request",
            "action must be begin, append, commit, or abort".to_string(),
        )),
    }
}

fn required_upload_field(value: Option<String>, name: &str) -> Result<String, OpError> {
    value.filter(|item| !item.is_empty()).ok_or_else(|| {
        OpError::new(
            "invalid_request",
            format!("{name} is required for this action"),
        )
    })
}

pub fn handle_file_edit(params: Value) -> Result<Value, OpError> {
    let params: EditParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.edit",
        &[digest_path(&params.path)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    let edits = match (params.edits, params.old_text, params.new_text) {
        (Some(edits), None, None) if !edits.is_empty() => edits,
        (None, Some(old_text), Some(new_text)) => vec![crate::params::FileEditOperation::Replace {
            old_text,
            new_text,
            expected_count: params.expected_count,
        }],
        _ => {
            return Err(OpError::new(
                "invalid_request",
                "provide either a non-empty edits array or legacy oldText/newText".to_string(),
            ));
        }
    };
    let outcome = crate::filesystem::edit::edit(&root, &params.path, &edits, params.revision)
        .map_err(file_error)?;
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
        "structuredPatch": outcome.structured_patch,
    }))
}

pub fn handle_file_delete(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.delete",
        &[digest_path(&params.path)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::delete(&root, &params.path).map_err(file_error)?;
    Ok(json!({ "kind": outcome.kind, "changedFiles": outcome.changed_files }))
}

pub fn handle_file_move(params: Value) -> Result<Value, OpError> {
    let params: MoveParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.move",
        &[digest_path(&params.from)?, digest_path(&params.to)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::move_path(&root, &params.from, &params.to).map_err(file_error)?;
    Ok(json!({ "from": outcome.from, "to": outcome.to, "changedFiles": outcome.changed_files }))
}

pub fn handle_file_mkdir(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(
        &params.grant,
        &params.workspace_root,
        "file.mkdir",
        &[digest_path(&params.path)?],
    )?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::mkdir(&root, &params.path).map_err(file_error)?;
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

/// 提权根复核（handler 权威，不信任请求声明）：绝对路径、深度 ≥2、
/// 与敏感根双向不重叠；违规一律 permission_denied（no-read 红线不可旁路）。
fn resolve_escalation_roots(raw: &[String]) -> Result<Vec<PathBuf>, OpError> {
    let sensitive = sandbox::sensitive_roots();
    let mut out = Vec::new();
    for value in raw {
        let declared = PathBuf::from(value);
        if !declared.is_absolute() {
            return Err(OpError::new(
                "invalid_request",
                "escalation root must be an absolute path".to_string(),
            ));
        }
        // 末段可能尚未创建（命令将要 mkdir 的目标）：解析最长现存祖先后拼回尾。
        let canonical = crate::sandbox::deepest_resolved(&declared);
        let components = canonical.components().count();
        if components < 3 {
            // 拒绝 / 与一级系统目录（/etc、/usr、/var…）作为提权根。
            return Err(OpError::new(
                "permission_denied",
                format!("escalation root too shallow (refusing broad system path): {value}"),
            ));
        }
        let overlaps_sensitive = sensitive.iter().any(|guard| {
            let guard_resolved = crate::sandbox::deepest_resolved(guard);
            canonical.starts_with(&guard_resolved) || guard_resolved.starts_with(&canonical)
        });
        if overlaps_sensitive {
            return Err(OpError::new(
                "permission_denied",
                format!("escalation root touches a protected credential path: {value}"),
            ));
        }
        out.push(canonical);
    }
    Ok(out)
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
        let extra = resolve_escalation_roots(&facts.escalation_roots)?;
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
    fn grep_rejects_conflicting_pattern_and_legacy_text() {
        let sandbox = Sandbox::new("grep-conflict");
        let conflict = handle_file_grep(json!({
            "workspaceRoot": sandbox.root_str(),
            "pattern": "new",
            "text": "old",
        }));
        let error = conflict.unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert!(error.message.contains("pattern and text differ"));

        let missing = handle_file_grep(json!({
            "workspaceRoot": sandbox.root_str(),
        }));
        assert_eq!(missing.unwrap_err().code, "invalid_request");
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
