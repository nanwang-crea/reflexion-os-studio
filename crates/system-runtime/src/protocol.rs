//! 协议/IO 基础设施：stdout 互斥与回包构造、工具操作错误类型、工作区根解析。
//! 与业务工具执行（handlers）和审批凭据校验（grant）解耦，保持单文件职责单一。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub const PROTOCOL_VERSION: &str = "1.0";
pub const RUNTIME_VERSION: &str = "0.3.0";

/// stdout 互斥：主循环与 shell 完成线程并发回包时防串行错乱。
static STDOUT_LOCK: Mutex<()> = Mutex::new(());

pub fn emit(message: Value) {
    let Ok(_guard) = STDOUT_LOCK.lock() else {
        return;
    };
    println!("{}", message);
    let _ = io::stdout().flush();
}

/// 运行中的 shell 子进程：requestId -> pid，供 system.cancel 树杀。
pub fn running_shells() -> &'static Mutex<HashMap<String, u32>> {
    static SHELLS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn ready_message() -> Value {
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
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

impl OpError {
    pub fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

pub fn error_response(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": data }
    })
}

pub fn workspace_root(value: &str) -> Result<PathBuf, OpError> {
    if value.trim().is_empty() {
        return Err(OpError::new(
            "invalid_request",
            "workspaceRoot must not be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(value))
}

pub fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 工具操作结果的统一回包：成功包 result，失败转 OpError。
pub fn finish(id: Value, result: Result<Value, OpError>) -> Result<(Value, bool), OpError> {
    result.map(|value| (ok_response(id, value), false))
}
