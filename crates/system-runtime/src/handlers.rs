//! 工具执行：根据方法名把 JSON-RPC params 落到各文件/搜索/变更/Shell/git 模块。
//! 写/执行类操作先经 grant（审批凭据）校验；异步操作（git 只读查询、shell）交给
//! 工作线程回包，避免阻塞协议主循环。

use serde_json::{json, Value};

use crate::grant::require_grant;
use crate::params::{
    EditParams, GitBranchesParams, GitDiffParams, GitStatusParams, GlobParams, GrantPathParams,
    GrepParams, ListParams, MoveParams, ReadParams, ShellParams, WriteParams,
};
use crate::protocol::{emit, error_response, ok_response, running_shells, workspace_root, OpError};
use crate::{files, git, mutate, paths, search, shell};

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
    }))
}

pub fn handle_file_list(params: Value) -> Result<Value, OpError> {
    let params: ListParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let entries = files::list(&root, &params.path, params.recursive.unwrap_or(false))
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "entries": entries }))
}

pub fn handle_file_glob(params: Value) -> Result<Value, OpError> {
    let params: GlobParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = search::glob_search(
        &root,
        &params.pattern,
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
    require_grant(&params.grant, &params.workspace_root, "file.write")?;
    let root = workspace_root(&params.workspace_root)?;
    let written = files::write(&root, &params.path, &params.content)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "writtenBytes": written }))
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
    )
    .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({
        "replacedCount": outcome.replaced_count,
        "sizeBytes": outcome.size_bytes,
    }))
}

pub fn handle_file_delete(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.delete")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::delete(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "kind": outcome.kind }))
}

pub fn handle_file_move(params: Value) -> Result<Value, OpError> {
    let params: MoveParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.move")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::move_path(&root, &params.from, &params.to)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "from": outcome.from, "to": outcome.to }))
}

pub fn handle_file_mkdir(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant, &params.workspace_root, "file.mkdir")?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::mkdir(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "path": outcome.path }))
}

/// git 只读查询（status/diff）：异步执行避免大仓库阻塞主循环，
/// 结果与错误照常 emit；进程级超时与收集在 git 模块内完成。
pub fn handle_git_status(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitStatusParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::status(&root) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_diff(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitDiffParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let path = params.path;
    let staged = params.staged.unwrap_or(false);
    std::thread::spawn(move || match git::diff(&root, &path, staged) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// git 本地分支只读查询（新建对话项目/分支选择用）；异步执行避免阻塞主循环。
pub fn handle_git_branches(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitBranchesParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::branches(&root) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
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
    let root = workspace_root(&params.workspace_root)?;
    let cwd_relative = params.cwd.as_deref().unwrap_or(".");
    let cwd = paths::resolve_in_workspace(&root, cwd_relative)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(shell::DEFAULT_TIMEOUT_MS)
        .min(shell::MAX_TIMEOUT_MS);
    // 异步执行：长命令不阻塞主循环，system.cancel 才能被及时处理。
    let request_id = shell_request_id(&id)?;
    let command = params.command;
    std::thread::spawn(move || {
        let outcome = shell::execute(&command, &cwd, timeout_ms, &|pid| {
            let _ = running_shells().lock().map(|mut shells| {
                shells.insert(request_id.clone(), pid);
            });
        });
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
