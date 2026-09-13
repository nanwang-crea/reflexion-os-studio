//! 终端服务：terminalId → 会话表、进程代际、协议方法入口
//! （spawn/write/resize/close）与关停统一回收 close_all。
//! 额度、背压窗口与消费者代际在 W2 补。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::protocol::{emit, OpError};
use crate::terminal::session::{self, TerminalSession};

/// W1 片段的活跃会话硬上限（额度系统 W2 接管）。
const MAX_ACTIVE_SESSIONS: usize = 16;

/// Rust 进程代际：进程内常量；跨 sidecar 重启的代际识别由 TS 侧观察
/// （进程重拉即新代际），W2 消费。
pub fn generation() -> u64 {
    static GEN: AtomicU64 = AtomicU64::new(1);
    static ONCE: OnceLock<u64> = OnceLock::new();
    *ONCE.get_or_init(|| GEN.fetch_add(1, Ordering::SeqCst))
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<TerminalSession>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<TerminalSession>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn required_str(params: &Value, key: &str) -> Result<String, OpError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .ok_or_else(|| OpError::new("invalid_request", format!("{key} is required")))
}

fn json_meta(session: &TerminalSession) -> Value {
    json!({
        "terminalId": session.id,
        "generation": session.generation,
        "outputSeq": session.output_seq.load(Ordering::SeqCst),
    })
}

pub fn handle_spawn(params: Value) -> Result<Value, OpError> {
    let terminal_id = required_str(&params, "terminalId")?;
    let cwd = required_str(&params, "cwd")?;
    let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
    let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
    let mut table = sessions()
        .lock()
        .map_err(|_| OpError::new("internal", "session table poisoned".to_string()))?;
    // 幂等：同 ID 已存在直接返回元数据，绝不产生第二个 shell（spec §5）。
    if let Some(existing) = table.get(&terminal_id) {
        return Ok(json_meta(existing));
    }
    if table.len() >= MAX_ACTIVE_SESSIONS {
        return Err(OpError::new(
            "too_many_terminals",
            "active terminal limit reached".to_string(),
        ));
    }
    let session = session::spawn(terminal_id.clone(), generation(), &cwd, rows, cols)
        .map_err(|message| OpError::new("pty_error", message))?;
    let meta = json_meta(&session);
    table.insert(terminal_id, session);
    Ok(meta)
}

fn session_by_id(terminal_id: &str) -> Result<Arc<TerminalSession>, OpError> {
    let table = sessions()
        .lock()
        .map_err(|_| OpError::new("internal", "session table poisoned".to_string()))?;
    table
        .get(terminal_id)
        .cloned()
        .ok_or_else(|| OpError::new("terminal_closed", "no such terminal".to_string()))
}

pub fn handle_write(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let data = required_str(&params, "data")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| OpError::new("invalid_request", format!("bad base64: {error}")))?;
    session_by_id(&id)?
        .write_input(&bytes)
        .map_err(|message| OpError::new("io_error", message))?;
    Ok(json!({ "acceptedBytes": bytes.len() }))
}

pub fn handle_resize(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let rows = params
        .get("rows")
        .and_then(Value::as_u64)
        .ok_or_else(|| OpError::new("invalid_request", "rows required".to_string()))?
        as u16;
    let cols = params
        .get("cols")
        .and_then(Value::as_u64)
        .ok_or_else(|| OpError::new("invalid_request", "cols required".to_string()))?
        as u16;
    session_by_id(&id)?
        .resize(rows, cols)
        .map_err(|message| OpError::new("io_error", message))?;
    Ok(json!({ "rows": rows, "cols": cols }))
}

pub fn handle_close(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let session = {
        let mut table = sessions()
            .lock()
            .map_err(|_| OpError::new("internal", "session table poisoned".to_string()))?;
        table.remove(&id)
    };
    match session {
        Some(session) => {
            let generation = session.generation;
            session.close();
            // 先收割再发状态：close 返回时进程必已消失。
            emit(json!({
                "jsonrpc": "2.0",
                "method": "terminal.state",
                "params": {
                    "terminalId": id,
                    "generation": generation,
                    "status": "closed",
                    "exitCode": null,
                }
            }));
        }
        // 幂等：不存在也返回成功（spec §4 close 幂等）。
        None => {}
    }
    Ok(json!({ "closed": true }))
}

/// 关停回收：全部并行 close（spec §8：不逐个等待；失败不假装——
/// 每个 close 自身阻塞到收割，SIGHUP-trap 边界见计划 W2 遗留）。
pub fn close_all() -> usize {
    let drained: Vec<Arc<TerminalSession>> = {
        let Ok(mut table) = sessions().lock() else {
            return 0;
        };
        table.drain().map(|(_, item)| item).collect()
    };
    let count = drained.len();
    std::thread::scope(|scope| {
        for item in drained {
            scope.spawn(move || item.close());
        }
    });
    count
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn spawn_is_idempotent_and_close_frees_slot() {
        let params = json!({ "terminalId": "svc1", "cwd": "/tmp", "rows": 24, "cols": 80 });
        let first = handle_spawn(params.clone()).expect("first spawn");
        let second = handle_spawn(params.clone()).expect("idempotent replay");
        assert_eq!(first["terminalId"], second["terminalId"]);
        assert_eq!(
            first["generation"], second["generation"],
            "幂等重放必须同代际"
        );
        handle_close(json!({ "terminalId": "svc1" })).expect("close");
        // 关闭后同 ID 再 spawn 成功（幂等记录短留由 W2 定义；W1 表即时移除）。
        handle_spawn(params).expect("respawn after close");
        handle_close(json!({ "terminalId": "svc1" })).expect("reclose");
    }

    #[test]
    fn operations_on_unknown_terminal_reject_with_stable_codes() {
        assert_eq!(
            handle_write(json!({ "terminalId": "ghost", "data": "aGk=" }))
                .unwrap_err()
                .code,
            "terminal_closed"
        );
        assert_eq!(
            handle_resize(json!({ "terminalId": "ghost", "rows": 1, "cols": 1 }))
                .unwrap_err()
                .code,
            "terminal_closed"
        );
        // close 幂等：未知 ID 仍成功。
        assert_eq!(
            handle_close(json!({ "terminalId": "ghost" })).unwrap()["closed"],
            true
        );
    }

    #[test]
    fn invalid_params_are_rejected() {
        assert_eq!(
            handle_spawn(json!({ "terminalId": "", "cwd": "/tmp" }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            handle_write(json!({ "terminalId": "svc2", "data": "!!!" }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
    }
}
