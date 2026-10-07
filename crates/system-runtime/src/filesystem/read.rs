//! 有界文本读取：模型分行展示与工作区原文读取共享路径和 revision 边界。
use super::files::{mtime_ms, DEFAULT_READ_LIMIT, MAX_READ_BYTES, MAX_READ_LIMIT};
use super::paths::resolve_in_workspace;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[cfg(test)]
pub fn read(
    workspace_root: &Path,
    relative: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ReadResult, String> {
    read_with_line_endings(workspace_root, relative, offset, limit, false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub content: String,
    pub size_bytes: u64,
    pub total_lines: usize,
    /// 本次返回首行的 0-based 行号（整读时为 0）。
    pub offset: usize,
    /// 读取时刻的文件 mtime（毫秒），revision 字段之一。
    pub modified_ms: u64,
    /// 读取时刻的完整文件 SHA-256（小写 hex），revision 字段之一。
    pub content_sha256: String,
    /// 本次是否覆盖了文件全部行（未触达单次行数上限）；只有完整读取
    /// 发放的 revision 才能通过 file.write 覆盖校验。
    pub read_complete: bool,
}

pub fn read_with_line_endings(
    workspace_root: &Path,
    relative: &str,
    offset: Option<usize>,
    limit: Option<usize>,
    preserve_line_endings: bool,
) -> Result<ReadResult, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.exists() {
        return Err(format!("file not found: {relative}"));
    }
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}"));
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let start = offset.unwrap_or(0);
    let max_lines = limit.unwrap_or(DEFAULT_READ_LIMIT).min(MAX_READ_LIMIT);
    let file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut selected = Vec::new();
    let mut total_lines = 0usize;
    let mut selected_bytes = 0u64;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer);
        let line_index = total_lines;
        total_lines += 1;
        if line_index < start || selected.len() >= max_lines {
            continue;
        }
        if !preserve_line_endings {
            while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                buffer.pop();
            }
        }
        selected_bytes += buffer.len() as u64;
        if selected_bytes > MAX_READ_BYTES {
            return Err(format!("requested line window exceeds {MAX_READ_BYTES} bytes; reduce limit or use file.grep"));
        }
        selected.push(
            String::from_utf8(buffer.clone())
                .map_err(|_| "file is not valid UTF-8 text (binary file?)".to_string())?,
        );
    }
    if start > total_lines {
        return Err(format!(
            "offset {start} beyond end of file ({total_lines} lines)"
        ));
    }
    let modified_ms = mtime_ms(&path)?;
    let read_complete = start == 0 && selected.len() >= total_lines;
    Ok(ReadResult {
        content: selected.join(if preserve_line_endings { "" } else { "\n" }),
        size_bytes: size,
        total_lines,
        offset: start,
        modified_ms,
        content_sha256: format!("{:x}", hasher.finalize()),
        read_complete,
    })
}

#[cfg(test)]
#[path = "read_tests.rs"]
mod tests;
