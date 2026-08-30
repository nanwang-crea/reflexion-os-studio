//! Rust System Runtime：文件/Shell 系统工具的执行边界（deny-by-default）。
//! 协议：JSON-RPC 2.0 over newline-delimited stdio；stdout 只传协议，stderr 只写日志。
//! 边界职责：workspace-relative 路径规范化、`..`/绝对路径/符号链接逃逸拒绝、
//! 体量与超时上限、进程树回收、写/执行类操作的 grant 存在性检查。
mod files;
mod glob;
mod mutate;
mod params;
mod paths;
mod search;
mod shell;
mod walk;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use params::{
    EditParams, GlobParams, GrantPathParams, GrepParams, ListParams, MoveParams, PathParams,
    ReadParams, ShellParams, WriteParams,
};

const PROTOCOL_VERSION: &str = "1.0";
const RUNTIME_VERSION: &str = "0.3.0";

/// stdout 互斥：主循环与 shell 完成线程并发回包时防串行错乱。
static STDOUT_LOCK: Mutex<()> = Mutex::new(());

fn emit(message: Value) {
    let Ok(_guard) = STDOUT_LOCK.lock() else {
        return;
    };
    println!("{}", message);
    let _ = io::stdout().flush();
}

/// 运行中的 shell 子进程：requestId -> pid，供 system.cancel 树杀。
fn running_shells() -> &'static Mutex<HashMap<u64, u32>> {
    static SHELLS: OnceLock<Mutex<HashMap<u64, u32>>> = OnceLock::new();
    SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ready_message() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "system.ready",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "capabilities": ["system.bootstrap", "system.tools"]
        }
    })
}

/// 工具操作失败：稳定 code 进 data，前端/模型据此理解失败类别。
struct OpError {
    code: &'static str,
    message: String,
}

impl OpError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

fn error_response(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": data }
    })
}

fn workspace_root(value: &str) -> Result<PathBuf, OpError> {
    if value.trim().is_empty() {
        return Err(OpError::new(
            "invalid_request",
            "workspaceRoot must not be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(value))
}

fn require_grant(grant: &str) -> Result<(), OpError> {
    if grant.trim().is_empty() {
        return Err(OpError::new(
            "grant_required",
            "write/execute operations require an approval grant".to_string(),
        ));
    }
    Ok(())
}

fn handle_file_read(params: Value) -> Result<Value, OpError> {
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

fn handle_file_list(params: Value) -> Result<Value, OpError> {
    let params: ListParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let entries = files::list(&root, &params.path, params.recursive.unwrap_or(false))
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "entries": entries }))
}

fn handle_file_glob(params: Value) -> Result<Value, OpError> {
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

fn handle_file_grep(params: Value) -> Result<Value, OpError> {
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

fn handle_file_write(params: Value) -> Result<Value, OpError> {
    let params: WriteParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
    let root = workspace_root(&params.workspace_root)?;
    let written = files::write(&root, &params.path, &params.content)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "writtenBytes": written }))
}

fn handle_file_edit(params: Value) -> Result<Value, OpError> {
    let params: EditParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
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

fn handle_file_delete(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::delete(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "kind": outcome.kind }))
}

fn handle_file_move(params: Value) -> Result<Value, OpError> {
    let params: MoveParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::move_path(&root, &params.from, &params.to)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "from": outcome.from, "to": outcome.to }))
}

fn handle_file_mkdir(params: Value) -> Result<Value, OpError> {
    let params: GrantPathParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
    let root = workspace_root(&params.workspace_root)?;
    let outcome = mutate::mkdir(&root, &params.path)
        .map_err(|message| OpError::new("file_error", message))?;
    Ok(json!({ "path": outcome.path }))
}

fn handle_shell_execute(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: ShellParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    require_grant(&params.grant)?;
    let root = workspace_root(&params.workspace_root)?;
    let cwd_relative = params.cwd.as_deref().unwrap_or(".");
    let cwd = paths::resolve_in_workspace(&root, cwd_relative)
        .map_err(|message| OpError::new("path_outside_workspace", message))?;
    let timeout_ms = params
        .timeout_ms
        .unwrap_or(shell::DEFAULT_TIMEOUT_MS)
        .min(shell::MAX_TIMEOUT_MS);
    // 异步执行：长命令不阻塞主循环，system.cancel 才能被及时处理。
    let request_id = id.as_u64().unwrap_or(0);
    let command = params.command;
    std::thread::spawn(move || {
        let outcome = shell::execute(&command, &cwd, timeout_ms, &|pid| {
            let _ = running_shells().lock().map(|mut shells| {
                shells.insert(request_id, pid);
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

fn handle_cancel(params: &Value) {
    let request_id = params.get("requestId").and_then(Value::as_u64);
    if let Some(request_id) = request_id {
        if let Ok(mut shells) = running_shells().lock() {
            if let Some(pid) = shells.remove(&request_id) {
                eprintln!("cancelling shell request {request_id} (pid {pid})");
                shell::kill_tree(pid);
            }
        }
    }
}

fn handle_request(request: &Value) -> (Value, bool) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let error_id = id.clone();
    let method = request.get("method").and_then(Value::as_str);
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let outcome: Result<(Value, bool), OpError> = match method {
        Some("system.ping") => Ok((ok_response(id, json!({ "ok": true })), false)),
        Some("system.shutdown") => Ok((ok_response(id, json!({ "ok": true })), true)),
        Some("file.read") => finish(id, handle_file_read(params)),
        Some("file.list") => finish(id, handle_file_list(params)),
        Some("file.glob") => finish(id, handle_file_glob(params)),
        Some("file.grep") => finish(id, handle_file_grep(params)),
        Some("file.write") => finish(id, handle_file_write(params)),
        Some("file.edit") => finish(id, handle_file_edit(params)),
        Some("file.delete") => finish(id, handle_file_delete(params)),
        Some("file.move") => finish(id, handle_file_move(params)),
        Some("file.mkdir") => finish(id, handle_file_mkdir(params)),
        Some("shell.execute") => handle_shell_execute(id, params),
        Some(name) => Err(OpError::new(
            "method_not_found",
            format!("Method not found: {name}"),
        )),
        None => Err(OpError::new(
            "invalid_request",
            "Invalid request".to_string(),
        )),
    };

    match outcome {
        // Null 哨兵：异步回包，主循环不再写响应。
        Ok((Value::Null, stop)) => (Value::Null, stop),
        Ok((response, stop)) => (response, stop),
        Err(error) => (
            error_response(
                error_id,
                -32000,
                &error.message,
                Some(json!({ "code": error.code })),
            ),
            false,
        ),
    }
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 工具操作结果的统一回包：成功包 result，失败转 OpError。
fn finish(id: Value, result: Result<Value, OpError>) -> Result<(Value, bool), OpError> {
    result.map(|value| (ok_response(id, value), false))
}

fn main() {
    emit(ready_message());
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                emit(error_response(Value::Null, -32700, "Parse error", None));
                continue;
            }
        };
        // 无 id 的通知不产生回包：目前只有 system.cancel（中止运行中的 shell）。
        if request.get("id").is_none() {
            if request.get("method").and_then(Value::as_str) == Some("system.cancel") {
                handle_cancel(request.get("params").unwrap_or(&Value::Null));
            }
            continue;
        }
        let (response, should_stop) = handle_request(&request);
        // Null 哨兵：shell.execute 异步回包，这里不写。
        if !response.is_null() {
            emit(response);
        }
        if should_stop {
            break;
        }
    }

    eprintln!("system runtime stopped");
}
