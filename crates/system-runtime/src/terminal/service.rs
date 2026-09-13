//! 终端服务：terminalId → 会话表、进程代际、协议方法入口
//! （spawn/attach/write/resize/ack/close）与关停统一回收 close_all。
//! attach/ack 为内部 TS→Rust 方法（不进 Tauri 白名单）：Rust 拥有背压
//! 原语（W2-2），消费者代际与 16ms 合帧在 TS 侧。

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

/// rows/cols 校验（M-2）：PTY 几何参数是 16 位——超 u16::MAX 报
/// invalid_request，绝不静默 `as u16` 回绕。default 为 Some 时字段可缺省
/// （spawn 走默认值），为 None 时必填（resize 语义，缺省/非整数都报错）。
fn dimension(params: &Value, key: &str, default: Option<u16>) -> Result<u16, OpError> {
    let invalid = || {
        OpError::new(
            "invalid_request",
            format!("{key} must be an integer ≤ {}", u16::MAX),
        )
    };
    match params.get(key) {
        None => default.ok_or_else(invalid),
        Some(value) => value
            .as_u64()
            .and_then(|number| u16::try_from(number).ok())
            .ok_or_else(invalid),
    }
}

/// spawn 幂等（同 ID 不产生第二个 shell，spec §5）。终端以**未 attach**
/// 状态启动：输出先进有界缓冲（W2-2 门控），attach 超时的回收决策归 TS。
pub fn handle_spawn(params: Value) -> Result<Value, OpError> {
    let terminal_id = required_str(&params, "terminalId")?;
    let cwd = required_str(&params, "cwd")?;
    let rows = dimension(&params, "rows", Some(24))?;
    let cols = dimension(&params, "cols", Some(80))?;
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

/// attach：打开输出交付闸门。幂等（重复 attach 换消费者、重新快照）；
/// 未知/已回收终端与 write/resize 同一稳定错误码。
pub fn handle_attach(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let consumer_id = required_str(&params, "consumerId")?;
    let replayed_bytes = session_by_id(&id)?.attach(&consumer_id);
    Ok(json!({ "replayedBytes": replayed_bytes }))
}

/// ack：累计确认已消费输出，释放 Rust 侧未确认窗口。未知/已回收终端报
/// terminal_closed；对存活终端的过期/重复 ack 幂等成功（spec §6）。
pub fn handle_ack(params: Value) -> Result<Value, OpError> {
    let id = required_str(&params, "terminalId")?;
    let through_output_seq = params
        .get("throughOutputSeq")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            OpError::new(
                "invalid_request",
                "throughOutputSeq is required".to_string(),
            )
        })?;
    session_by_id(&id)?.ack(through_output_seq);
    Ok(json!({ "ok": true }))
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
    let rows = dimension(&params, "rows", None)?;
    let cols = dimension(&params, "cols", None)?;
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
/// 每个 close 自身阻塞到收割，含 500ms 时限的 SIGKILL 升级兜底）。
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
        // W2-2：attach/ack 与 write/resize 同一稳定错误码（未知/已回收）。
        assert_eq!(
            handle_attach(json!({ "terminalId": "ghost", "consumerId": "c" }))
                .unwrap_err()
                .code,
            "terminal_closed"
        );
        assert_eq!(
            handle_ack(json!({ "terminalId": "ghost", "throughOutputSeq": 0 }))
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

    /// W2-2 服务面：attach 幂等且返回缓冲快照；ack 累计确认幂等。
    /// M-4：不再 sleep-then-assert——有界轮询（≤5 s）幂等 spawn 重放的
    /// outputSeq（无门控副作用）：≥2 帧编号且相邻采样稳定（fetch_add 先于
    /// push，稳定一轮说明在途帧已入队）后才做一次真实 attach——attach 门
    /// 未开过，字节只会留在缓冲里。
    #[test]
    fn attach_is_idempotent_and_ack_releases_ok() {
        let params = json!({ "terminalId": "svc-attach", "cwd": "/tmp", "rows": 24, "cols": 80 });
        handle_spawn(params.clone()).expect("spawn");
        handle_write(
            json!({ "terminalId": "svc-attach", "data": base64::engine::general_purpose::STANDARD.encode("echo SVC_HELD\r") }),
        )
        .expect("write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut last_seq = 0u64;
        loop {
            let meta = handle_spawn(params.clone()).expect("幂等重放读 meta");
            let seq = meta["outputSeq"].as_u64().unwrap_or(0);
            if seq >= 2 && seq == last_seq {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "超时：提示符+回显未编号入队，meta={meta}"
            );
            last_seq = seq;
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let first = handle_attach(json!({ "terminalId": "svc-attach", "consumerId": "c1" }))
            .expect("attach");
        assert!(
            first["replayedBytes"].as_u64().expect("number") >= 10,
            "attach 前缓冲必须被快照报告：{first}"
        );
        let second = handle_attach(json!({ "terminalId": "svc-attach", "consumerId": "c2" }))
            .expect("reattach 幂等");
        assert!(second["replayedBytes"].is_number());
        // 超前/重复 ack：对存活终端一律幂等 ok:true（队列层 no-op）。
        assert_eq!(
            handle_ack(json!({ "terminalId": "svc-attach", "throughOutputSeq": 0 })).unwrap()["ok"],
            true
        );
        assert_eq!(
            handle_ack(json!({ "terminalId": "svc-attach", "throughOutputSeq": 0 })).unwrap()["ok"],
            true
        );
        handle_close(json!({ "terminalId": "svc-attach" })).expect("close");
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
        assert_eq!(
            handle_attach(json!({ "terminalId": "svc2" }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            handle_ack(json!({ "terminalId": "svc2" }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
    }

    /// M-2：rows/cols 超 u16::MAX 或非法类型报 invalid_request，
    /// 绝不静默 `as u16` 回绕；恰为 65535 合法（走到会话查找的
    /// terminal_closed，证明校验边界而非一律拒绝）。
    #[test]
    fn oversized_dimensions_are_rejected_not_wrapped() {
        assert_eq!(
            handle_spawn(json!({ "terminalId": "dims", "cwd": "/tmp", "rows": 70000 }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            handle_resize(json!({ "terminalId": "dims", "rows": 24, "cols": 65536 }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            handle_resize(json!({ "terminalId": "dims", "rows": 24, "cols": "wide" }))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            handle_resize(json!({ "terminalId": "ghost-dims", "rows": 65535, "cols": 65535 }))
                .unwrap_err()
                .code,
            "terminal_closed"
        );
    }
}
