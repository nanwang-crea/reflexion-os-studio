//! File Service：workspace 内的读取/列表/写入。
//! 路径边界由 paths::resolve_in_workspace 强制；本模块只做能力与体量限制。
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::paths::resolve_in_workspace;
use super::walk::walk_files;

/// 返回文本窗口的字节上限；流式扫描整文件计算 revision，不全量载入。
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_BINARY_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
/// 单次列表分页默认/最大条目数：防止一次吃满上下文，超限可经 nextOffset 续读。
pub const DEFAULT_LIST_LIMIT: usize = 200;
pub const MAX_LIST_LIMIT: usize = 2000;
/// 分段读取单次默认/最大行数：防止一次吃满上下文。
pub const DEFAULT_READ_LIMIT: usize = 2000;
pub const MAX_READ_LIMIT: usize = 10_000;

#[cfg(test)]
pub use super::read::read;
pub use super::read::read_with_line_endings;

pub fn read_binary(workspace_root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_file() {
        return Err(format!("file not found or not regular: {relative}"));
    }
    let size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_BINARY_PREVIEW_BYTES {
        return Err(format!(
            "binary preview exceeds {MAX_BINARY_PREVIEW_BYTES} bytes"
        ));
    }
    fs::read(path).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<super::walk::FileEntry>,
    pub returned_count: usize,
    /// 另有后续页可续读，或遍历触达硬上限导致结果不完整。
    pub truncated: bool,
    /// 仍有后续内容时指向下一次请求的偏移量；硬上限截断且已无内容时缺失。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

pub fn list(
    workspace_root: &Path,
    relative: &str,
    recursive: bool,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ListResult, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_dir() {
        return Err(format!("not a directory: {relative}"));
    }
    // 输出路径统一为 workspace 相对形状（去掉多余的 "./" 前缀），可直接回传给后续工具调用。
    let prefix = Path::new(relative)
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(name) => Some(name.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    let (mut entries, hard_truncated) = if recursive {
        let walked = walk_files(&path, &prefix);
        (walked.files, walked.truncated)
    } else {
        let mut entries = Vec::new();
        let mut incomplete = false;
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let Ok(entry) = entry else {
                incomplete = true;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                incomplete = true;
                continue;
            };
            // 个别条目无权限/被删除不能阻断整棵文件树，保留可枚举的条目。
            let size_bytes = match entry.metadata() {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    incomplete = true;
                    0
                }
            };
            let kind = if file_type.is_dir() {
                "dir"
            } else if file_type.is_file() {
                "file"
            } else {
                "other"
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if super::upload::is_upload_artifact_name(&name) {
                continue;
            }
            entries.push(super::walk::FileEntry {
                path: if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                },
                kind: kind.to_string(),
                size_bytes,
            });
        }
        (entries, incomplete)
    };
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let page: Vec<super::walk::FileEntry> =
        entries.iter().skip(offset).take(limit).cloned().collect();
    let returned_count = page.len();
    let page_end = offset.saturating_add(returned_count);
    let more_pages = page_end < entries.len();
    Ok(ListResult {
        entries: page,
        returned_count,
        truncated: hard_truncated || more_pages,
        next_offset: if more_pages { Some(page_end) } else { None },
    })
}

/// Revision 凭据：mtime + size + sha256 三字段，标识"一次完整读取"。
/// mtime/size 检出修改，sha256 兜底同毫秒碰撞；由 Rust 侧在 file.read
/// （未截断窗口）与 file.write / file.edit 成功后统一计算并返回。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub modified_ms: u64,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub written_bytes: u64,
    /// 目标原不存在、本次为新建时为 true。
    pub created: bool,
    /// 写入后的新 mtime（毫秒），调用方记入读取状态供后续编辑使用。
    pub modified_ms: u64,
    /// 写入后完整内容的 revision：覆盖写的调用方直接获得可继续 edit 的凭据。
    pub revision: Revision,
}

/// 覆盖已存在文件必须携带 revision（一次 file.read 完整读取的凭据）：
/// 未携带视为盲写拒绝；mtime / size / sha256 任一不一致视为读取后被外部修改
/// （错误按字段分档，便于定位是陈旧凭据还是同毫秒内容漂移）。
/// 新建文件豁免先读约束。
pub fn write(
    workspace_root: &Path,
    relative: &str,
    content: &str,
    revision: Option<Revision>,
) -> Result<WriteOutcome, String> {
    let content_bytes = content.as_bytes();
    if content_bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "content too large for write: {} bytes (limit {MAX_WRITE_BYTES})",
            content_bytes.len()
        ));
    }
    let path = resolve_in_workspace(workspace_root, relative)?;
    let existed = validate_write_target(&path, relative, revision.as_ref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(&path, content_bytes)?;
    let modified_ms = mtime_ms(&path)?;
    let outcome_revision = Revision {
        modified_ms,
        size_bytes: content_bytes.len() as u64,
        sha256: super::sha256::hex_digest(content_bytes),
    };
    Ok(WriteOutcome {
        written_bytes: content_bytes.len() as u64,
        created: !existed,
        modified_ms,
        revision: outcome_revision,
    })
}

pub(crate) fn validate_write_target(
    path: &Path,
    relative: &str,
    revision: Option<&Revision>,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}"));
    }
    let token = revision.ok_or_else(|| {
        format!(
            "refusing to overwrite existing file '{relative}' without a fresh full read: \
             run file.read on it first (until no truncation), then retry this write"
        )
    })?;
    let current_ms = mtime_ms(path)?;
    let current_size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if current_ms != token.modified_ms {
        return Err(format!(
            "file changed since last read (mtime {current_ms} != revision {}); \
             re-run file.read on '{relative}' before writing",
            token.modified_ms
        ));
    }
    if current_size != token.size_bytes {
        return Err(format!(
            "file changed since last read (size {current_size} != revision {}); \
             re-run file.read on '{relative}' before writing",
            token.size_bytes
        ));
    }
    let current_sha256 = super::sha256::hex_digest(&fs::read(path).map_err(|e| e.to_string())?);
    if current_sha256 != token.sha256 {
        return Err(format!(
            "file content changed since last read (same mtime but sha256 mismatch); \
             re-run file.read on '{relative}' before writing"
        ));
    }
    Ok(true)
}

/// 文件 mtime（毫秒）；作为先读后写的凭据与陈旧检测依据。
/// 文件系统时间戳精度低于毫秒时，同毫秒内的外部修改无法检出（尽力而为）。
pub(crate) fn mtime_ms(path: &Path) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .map_err(|e| e.to_string())?
        .modified()
        .map_err(|e| e.to_string())?;
    let since_epoch = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "file mtime before unix epoch".to_string())?;
    Ok(since_epoch.as_millis() as u64)
}

/// 原子写：先写同目录临时文件再 rename 覆盖，进程中断不会留下截断文件。
/// Unix 上保留原文件权限（临时文件默认权限受 umask 影响）；rename 在
/// Windows 使用 MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH) 覆盖已有目标。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "invalid file name".to_string())?
        .to_string_lossy();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(
        ".{name}.tmp-{}-{nanos}-{sequence}",
        std::process::id()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, metadata.permissions());
    }
    replace_file(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e
    })?;
    #[cfg(unix)]
    fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
