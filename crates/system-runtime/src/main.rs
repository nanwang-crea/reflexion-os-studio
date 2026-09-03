//! Rust System Runtime：文件/Shell 系统工具的执行边界（deny-by-default）。
//! 协议：JSON-RPC 2.0 over newline-delimited stdio；stdout 只传协议，stderr 只写日志。
//! 边界职责：workspace-relative 路径规范化、`..`/绝对路径/符号链接逃逸拒绝、
//! 体量与超时上限、进程树回收、写/执行类操作的 grant 存在性检查。
//!
//! 职责拆分：`protocol`（IO/回包/错误类型）、`grant`（审批凭据校验）、
//! `handlers`（各工具执行）分别独立成模块，本文件只留协议分发与主循环。

mod files;
mod git;
mod glob;
mod grant;
mod handlers;
mod mutate;
mod params;
mod paths;
mod protocol;
mod search;
mod shell;
mod walk;

use serde_json::{json, Value};
use std::io::{self, BufRead};

use crate::protocol::{error_response, finish, ok_response, OpError};

fn handle_request(request: &Value) -> (Value, bool) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let error_id = id.clone();
    let method = request.get("method").and_then(Value::as_str);
    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let outcome: Result<(Value, bool), OpError> = match method {
        Some("system.ping") => Ok((ok_response(id, json!({ "ok": true })), false)),
        Some("system.shutdown") => Ok((ok_response(id, json!({ "ok": true })), true)),
        Some("file.read") => finish(id, handlers::handle_file_read(params)),
        Some("file.list") => finish(id, handlers::handle_file_list(params)),
        Some("file.glob") => finish(id, handlers::handle_file_glob(params)),
        Some("file.grep") => finish(id, handlers::handle_file_grep(params)),
        Some("file.write") => finish(id, handlers::handle_file_write(params)),
        Some("file.edit") => finish(id, handlers::handle_file_edit(params)),
        Some("file.delete") => finish(id, handlers::handle_file_delete(params)),
        Some("file.move") => finish(id, handlers::handle_file_move(params)),
        Some("file.mkdir") => finish(id, handlers::handle_file_mkdir(params)),
        Some("shell.execute") => handlers::handle_shell_execute(id, params),
        Some("git.status") => handlers::handle_git_status(id, params),
        Some("git.diff") => handlers::handle_git_diff(id, params),
        Some("git.branches") => handlers::handle_git_branches(id, params),
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

#[cfg(test)]
mod tests {
    use crate::grant::require_grant;
    use serde_json::json;

    fn grant(workspace: &str, operation: &str, expires_at: u64) -> String {
        json!({
            "grantId": "grant-1", "requestId": "request-1", "sessionId": "session-1",
            "workspaceId": workspace, "operation": operation, "scope": "once",
            "expiresAt": expires_at,
        })
        .to_string()
    }

    #[test]
    fn validates_grant_binding_and_expiry() {
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        assert!(require_grant(
            &grant("/workspace", "file.write", future),
            "/workspace",
            "file.write"
        )
        .is_ok());
        assert_eq!(
            require_grant(
                &grant("/other", "file.write", future),
                "/workspace",
                "file.write"
            )
            .unwrap_err()
            .code,
            "invalid_grant"
        );
        assert_eq!(
            require_grant(
                &grant("/workspace", "shell.execute", future),
                "/workspace",
                "file.write"
            )
            .unwrap_err()
            .code,
            "invalid_grant"
        );
        assert_eq!(
            require_grant(
                &grant("/workspace", "file.write", 0),
                "/workspace",
                "file.write"
            )
            .unwrap_err()
            .code,
            "grant_expired"
        );
    }

    #[test]
    fn rejects_malformed_and_incomplete_grants() {
        assert_eq!(
            require_grant("grant-1", "/workspace", "file.write")
                .unwrap_err()
                .code,
            "invalid_grant"
        );
        let value = json!({ "grantId": "g", "requestId": "r", "sessionId": "", "workspaceId": "/workspace", "operation": "file.write", "scope": "once", "expiresAt": u64::MAX });
        assert_eq!(
            require_grant(&value.to_string(), "/workspace", "file.write")
                .unwrap_err()
                .code,
            "invalid_grant"
        );
    }
}

fn main() {
    protocol::emit(protocol::ready_message());
    let stdin = io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => break,
        };
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                protocol::emit(error_response(Value::Null, -32700, "Parse error", None));
                continue;
            }
        };
        // 无 id 的通知不产生回包：目前只有 system.cancel（中止运行中的 shell）。
        if request.get("id").is_none() {
            if request.get("method").and_then(Value::as_str) == Some("system.cancel") {
                handlers::handle_cancel(request.get("params").unwrap_or(&Value::Null));
            }
            continue;
        }
        let (response, should_stop) = handle_request(&request);
        // Null 哨兵：shell.execute 异步回包，这里不写。
        if !response.is_null() {
            protocol::emit(response);
        }
        if should_stop {
            break;
        }
    }

    eprintln!("system runtime stopped");
}
