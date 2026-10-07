//! 工具执行：根据方法名把 JSON-RPC params 落到各文件/搜索/变更/Shell 模块。
//! 写/执行先校验 grant；Shell 在线程执行，Git 方法见 handlers_git。

use base64::Engine;
use serde_json::{json, Value};

use crate::filesystem::{files, mutate, search, upload};
use crate::grant::{normalize_relative, require_grant};
use crate::params::{
    BinaryReadParams, EditParams, GlobParams, GrantPathParams, GrepParams, ListParams, MoveParams,
    OperationSource, ReadParams, StreamWriteParams, UnwatchParams, WatchParams, WriteParams,
};
use crate::protocol::{workspace_root, OpError};
pub use crate::shell::handlers::{handle_cancel, handle_shell_execute};

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
    let result = files::read_with_line_endings(
        &root,
        &params.path,
        params.offset,
        params.limit,
        params.preserve_line_endings,
    )
    .map_err(file_error)?;
    Ok(json!({
        "content": result.content,
        "sizeBytes": result.size_bytes,
        "totalLines": result.total_lines,
        "offset": result.offset,
        "modifiedMs": result.modified_ms,
        "contentSha256": result.content_sha256,
        "readComplete": result.read_complete,
        // 整读发放覆盖写凭据，分页只可用于片段编辑。
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
