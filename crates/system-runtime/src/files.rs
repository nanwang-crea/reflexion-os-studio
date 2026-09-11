//! File Service：workspace 内的读取/列表/写入。
//! 路径边界由 paths::resolve_in_workspace 强制；本模块只做能力与体量限制。
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::paths::resolve_in_workspace;
use crate::walk::walk_files;

/// 整文件读取上限：按行分窗不减少加载量（读前需全量载入定位行边界），
/// 因此限制的是文件总大小；返回给模型的窗口仍由行数与 TS 层字符预算约束。
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
/// 单次列表分页默认/最大条目数：防止一次吃满上下文，超限可经 nextOffset 续读。
pub const DEFAULT_LIST_LIMIT: usize = 200;
pub const MAX_LIST_LIMIT: usize = 2000;
/// 分段读取单次默认/最大行数：防止一次吃满上下文。
pub const DEFAULT_READ_LIMIT: usize = 2000;
pub const MAX_READ_LIMIT: usize = 10_000;

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

pub fn read(
    workspace_root: &Path,
    relative: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ReadResult, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.exists() {
        return Err(format!("file not found: {relative}"));
    }
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}"));
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES {
        return Err(format!(
            "file too large for read: {size} bytes (whole-file limit {MAX_READ_BYTES} bytes); \
             line-windowed reads still load the entire file — use file.grep to locate content \
             in larger files, or file.list to check sizes"
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let content = String::from_utf8(bytes).map_err(|_| {
        "file is not valid UTF-8 text (binary file?); file.grep skips binary files \
         automatically, and file.list shows file sizes"
            .to_string()
    })?;
    let total_lines = content.lines().count();
    let start = offset.unwrap_or(0);
    if start > total_lines {
        return Err(format!(
            "offset {start} beyond end of file ({total_lines} lines)"
        ));
    }
    let max_lines = limit.unwrap_or(DEFAULT_READ_LIMIT).min(MAX_READ_LIMIT);
    let selected: Vec<&str> = content.lines().skip(start).take(max_lines).collect();
    let modified_ms = mtime_ms(&path)?;
    let read_complete = start + selected.len() >= total_lines;
    Ok(ReadResult {
        content: selected.join("\n"),
        size_bytes: size,
        total_lines,
        offset: start,
        modified_ms,
        content_sha256: crate::sha256::hex_digest(content.as_bytes()),
        read_complete,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<crate::walk::FileEntry>,
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
    let prefix = if relative == "." {
        ""
    } else {
        relative.trim_start_matches("./")
    };
    let (mut entries, hard_truncated) = if recursive {
        let walked = walk_files(&path, prefix);
        (walked.files, walked.truncated)
    } else {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let kind = if metadata.is_dir() {
                "dir"
            } else if metadata.is_file() {
                "file"
            } else {
                "other"
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(crate::walk::FileEntry {
                path: if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                },
                kind: kind.to_string(),
                size_bytes: metadata.len(),
            });
        }
        (entries, false)
    };
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let page: Vec<crate::walk::FileEntry> =
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
    let existed = path.exists();
    if existed {
        if !path.is_file() {
            return Err(format!("not a regular file: {relative}"));
        }
        let token = revision.ok_or_else(|| {
            format!(
                "refusing to overwrite existing file '{relative}' without a fresh full read: \
                 run file.read on it first (until no truncation), then retry this write"
            )
        })?;
        let current_ms = mtime_ms(&path)?;
        let current_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
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
        let current_sha256 =
            crate::sha256::hex_digest(&fs::read(&path).map_err(|e| e.to_string())?);
        if current_sha256 != token.sha256 {
            return Err(format!(
                "file content changed since last read (same mtime but sha256 mismatch); \
                 re-run file.read on '{relative}' before writing"
            ));
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(&path, content_bytes)?;
    let modified_ms = mtime_ms(&path)?;
    let outcome_revision = Revision {
        modified_ms,
        size_bytes: content_bytes.len() as u64,
        sha256: crate::sha256::hex_digest(content_bytes),
    };
    Ok(WriteOutcome {
        written_bytes: content_bytes.len() as u64,
        created: !existed,
        modified_ms,
        revision: outcome_revision,
    })
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
/// Windows 上等价于 MoveFileExW(REPLACE_EXISTING)，可覆盖已存在目标。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    let temp = dir.join(format!(".{name}.tmp{nanos}"));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, metadata.permissions());
    }
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("reflexion-files-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_write_roundtrip_inside_workspace() {
        let root = temp_workspace("roundtrip");
        let outcome = write(&root, "docs/note.txt", "你好工作区", None).unwrap();
        assert!(outcome.created);
        let read = read(&root, "docs/note.txt", None, None).unwrap();
        assert_eq!(read.content, "你好工作区");
        assert_eq!(read.total_lines, 1);
        assert_eq!(read.modified_ms, outcome.modified_ms);
        // 读取响应携带完整 revision，且与写入方返回的一致（同一内容）。
        assert_eq!(read.content_sha256, outcome.revision.sha256);
        assert_eq!(read.size_bytes, outcome.revision.size_bytes);
        let entries = list(&root, ".", false, None, None).unwrap();
        assert_eq!(entries.entries[0].path, "docs");
        assert_eq!(entries.entries[0].kind, "dir");
        assert_eq!(entries.returned_count, 1);
        assert!(!entries.truncated);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_requires_fresh_revision_for_existing_files() {
        let root = temp_workspace("write-token");
        let created = write(&root, "a.txt", "v1", None).unwrap();
        assert!(created.created);
        // 未携带 revision 的覆盖写被拒绝。
        assert!(write(&root, "a.txt", "v2", None).is_err());
        // 陈旧 revision（mtime 不一致）被拒绝。
        let stale = crate::files::Revision {
            modified_ms: created.revision.modified_ms + 1,
            size_bytes: created.revision.size_bytes,
            sha256: created.revision.sha256.clone(),
        };
        assert!(write(&root, "a.txt", "v2", Some(stale)).is_err());
        // 完整读取获得 revision 后成功覆盖；返回写入后的新 revision。
        let fresh = read(&root, "a.txt", None, None).unwrap();
        let token = Revision {
            modified_ms: fresh.modified_ms,
            size_bytes: fresh.size_bytes,
            sha256: fresh.content_sha256.clone(),
        };
        let overwritten = write(&root, "a.txt", "v2", Some(token)).unwrap();
        assert!(!overwritten.created);
        assert!(overwritten.modified_ms >= fresh.modified_ms);
        assert_eq!(
            overwritten.revision.sha256,
            crate::sha256::hex_digest(b"v2")
        );
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "v2");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_rejects_revision_field_mismatches() {
        let root = temp_workspace("write-revision");
        write(&root, "a.txt", "original", None).unwrap();
        let fresh = read(&root, "a.txt", None, None).unwrap();
        let base = Revision {
            modified_ms: fresh.modified_ms,
            size_bytes: fresh.size_bytes,
            sha256: fresh.content_sha256,
        };
        // 同 mtime 但 size 不一致（外部追加修改的形态）。
        let size_mismatch = Revision {
            size_bytes: base.size_bytes + 1,
            ..base.clone()
        };
        assert!(write(&root, "a.txt", "v2", Some(size_mismatch)).is_err());
        // mtime/size 一致但 sha256 不一致（同毫秒内内容漂移的兜底）。
        let sha_mismatch = Revision {
            sha256: "0".repeat(64),
            ..base.clone()
        };
        assert!(write(&root, "a.txt", "v2", Some(sha_mismatch)).is_err());
        // 内容未被外部改动：正确 revision 覆盖成功。
        assert!(write(&root, "a.txt", "v2", Some(base)).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_returns_revision_and_roundtrips_through_write() {
        let root = temp_workspace("revision");
        write(&root, "a.txt", "line1\nline2\n", None).unwrap();
        let full = read(&root, "a.txt", None, None).unwrap();
        assert_eq!(
            full.content_sha256,
            crate::sha256::hex_digest(b"line1\nline2\n")
        );
        // 未触达行数上限 → 完整读取。
        assert!(full.read_complete);
        let paged = read(&root, "a.txt", None, Some(1)).unwrap();
        // 触达 limit 的窗口不是完整读取。
        assert!(!paged.read_complete);
        assert_eq!(paged.content_sha256, full.content_sha256);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_reading_outside_workspace() {
        let root = temp_workspace("escape");
        assert!(read(&root, "../../Cargo.toml", None, None).is_err());
        assert!(read(&root, "missing.txt", None, None).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_supports_line_windowing() {
        let root = temp_workspace("window");
        let body = "l0\nl1\nl2\nl3\n";
        write(&root, "w.txt", body, None).unwrap();
        let paged = read(&root, "w.txt", Some(1), Some(2)).unwrap();
        assert_eq!(paged.content, "l1\nl2");
        assert_eq!(paged.total_lines, 4);
        assert_eq!(paged.offset, 1);
        let tail = read(&root, "w.txt", Some(3), Some(10)).unwrap();
        assert_eq!(tail.content, "l3");
        assert!(read(&root, "w.txt", Some(9), None).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_paginates_sorted_directory_entries_with_metadata() {
        let root = temp_workspace("pagination");
        write(&root, "z.txt", "z", None).unwrap();
        write(&root, "a.txt", "a", None).unwrap();
        write(&root, "m.txt", "m", None).unwrap();
        let first = list(&root, ".", false, Some(0), Some(2)).unwrap();
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "m.txt"]
        );
        assert_eq!(first.returned_count, 2);
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));
        let second = list(&root, ".", false, first.next_offset, Some(2)).unwrap();
        assert_eq!(second.entries[0].path, "z.txt");
        assert_eq!(second.returned_count, 1);
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recursive_list_walks_nested_dirs() {
        let root = temp_workspace("recursive");
        write(&root, "src/deep/mod.rs", "fn main() {}", None).unwrap();
        write(&root, "README.md", "# hi", None).unwrap();
        let entries = list(&root, ".", true, None, None).unwrap();
        let paths: Vec<&str> = entries.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/deep/mod.rs"]);
        assert!(!entries.truncated);
        let sub = list(&root, "src", true, None, None).unwrap();
        assert_eq!(sub.returned_count, 1);
        assert_eq!(sub.entries[0].path, "src/deep/mod.rs");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recursive_list_paginates_in_stable_path_order() {
        let root = temp_workspace("recursive-pagination");
        write(&root, "src/z.rs", "z", None).unwrap();
        write(&root, "README.md", "readme", None).unwrap();
        write(&root, "src/a.rs", "a", None).unwrap();
        let first = list(&root, ".", true, Some(0), Some(2)).unwrap();
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md", "src/a.rs"]
        );
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));
        let second = list(&root, ".", true, first.next_offset, Some(2)).unwrap();
        assert_eq!(second.entries[0].path, "src/z.rs");
        assert_eq!(second.returned_count, 1);
        assert!(!second.truncated);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_normalizes_zero_limit_to_at_least_one_entry() {
        let root = temp_workspace("zero-limit");
        write(&root, "b.txt", "b", None).unwrap();
        write(&root, "a.txt", "a", None).unwrap();
        let result = list(&root, ".", false, None, Some(0)).unwrap();
        assert_eq!(result.returned_count, 1);
        assert_eq!(result.entries[0].path, "a.txt");
        assert_eq!(result.next_offset, Some(1));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_returns_stable_empty_page_for_offset_beyond_bounds() {
        let root = temp_workspace("offset-beyond");
        write(&root, "a.txt", "a", None).unwrap();
        let result = list(&root, ".", false, Some(1), Some(2)).unwrap();
        assert!(result.entries.is_empty());
        assert_eq!(result.returned_count, 0);
        assert!(!result.truncated);
        assert_eq!(result.next_offset, None);
        let maxed = list(&root, ".", false, Some(usize::MAX), Some(2)).unwrap();
        assert!(maxed.entries.is_empty());
        assert!(!maxed.truncated);
        assert_eq!(maxed.next_offset, None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recursive_list_reports_walk_hard_cap_without_fake_continuation() {
        let root = temp_workspace("depth-cap");
        write(&root, "top.txt", "t", None).unwrap();
        let mut deep = root.clone();
        for index in 0..(crate::walk::MAX_WALK_DEPTH + 2) {
            deep = deep.join(format!("d{index}"));
            fs::create_dir_all(&deep).unwrap();
        }
        fs::write(deep.join("leaf.txt"), "x").unwrap();
        let result = list(&root, ".", true, None, None).unwrap();
        assert!(result.truncated);
        assert_eq!(result.next_offset, None);
        fs::remove_dir_all(&root).ok();
    }
}
