//! 宿主诊断日志：仅记录 stderr，不记录 JSON-RPC 正文、聊天内容或配置凭据。
mod rotation;

use rotation::RotatingLog;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: OnceLock<Mutex<RotatingLog>> = OnceLock::new();
const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_KEEP_FILES: usize = 3;

pub(crate) fn init(default_directory: PathBuf) {
    let directory = std::env::var_os("REFLEXION_LOG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_directory);
    let max_bytes = std::env::var("REFLEXION_LOG_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1024..=100 * 1024 * 1024).contains(value))
        .unwrap_or(DEFAULT_MAX_BYTES);
    let keep_files = std::env::var("REFLEXION_LOG_KEEP_FILES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=20).contains(value))
        .unwrap_or(DEFAULT_KEEP_FILES);
    match RotatingLog::new(&directory, max_bytes, keep_files) {
        Ok(writer) => {
            let _ = LOG.set(Mutex::new(writer));
            write(&format!(
                "[host] log directory: {} (maxBytes={max_bytes}, keepFiles={keep_files})",
                directory.display()
            ));
        }
        Err(error) => write(&format!("[host] log initialization failed: {error}")),
    }
}

pub(crate) fn write(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!(
        "[{timestamp} pid={}] {}",
        std::process::id(),
        message.trim_end()
    );
    let _ = writeln!(std::io::stderr().lock(), "{line}");
    if let Some(log) = LOG.get() {
        if let Ok(mut writer) = log.lock() {
            if let Err(error) = writer.write(&line) {
                let _ = writeln!(std::io::stderr().lock(), "[host] log write failed: {error}");
            }
        }
    }
}
