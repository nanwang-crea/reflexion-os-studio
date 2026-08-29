use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "1.0";
const RUNTIME_VERSION: &str = "0.1.0";

fn emit(message: Value) {
    println!("{}", message);
    let _ = io::stdout().flush();
}

fn ready_message() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "system.ready",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeVersion": RUNTIME_VERSION,
            "capabilities": ["system.bootstrap"]
        }
    })
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn handle_request(request: &Value) -> (Value, bool) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str);

    match method {
        Some("system.ping") => (
            json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }),
            false,
        ),
        Some("system.shutdown") => (
            json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }),
            true,
        ),
        Some(name) => (
            error_response(id, -32601, &format!("Method not found: {}", name)),
            false,
        ),
        None => (error_response(id, -32600, "Invalid request"), false),
    }
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
                emit(error_response(Value::Null, -32700, "Parse error"));
                continue;
            }
        };
        let (response, should_stop) = handle_request(&request);
        emit(response);
        if should_stop {
            break;
        }
    }

    eprintln!("system runtime stopped");
}
