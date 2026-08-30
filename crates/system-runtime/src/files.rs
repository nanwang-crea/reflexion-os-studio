//! File Service：workspace 内的读取/列表/写入。
//! 路径边界由 paths::resolve_in_workspace 强制；本模块只做能力与体量限制。
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::paths::resolve_in_workspace;
use crate::walk::walk_files;

pub const MAX_READ_BYTES: u64 = 512 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 2000;
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
            "file too large for read: {size} bytes (limit {MAX_READ_BYTES})"
        ));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let content =
        String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    let total_lines = content.lines().count();
    let start = offset.unwrap_or(0);
    if start > total_lines {
        return Err(format!(
            "offset {start} beyond end of file ({total_lines} lines)"
        ));
    }
    let max_lines = limit.unwrap_or(DEFAULT_READ_LIMIT).min(MAX_READ_LIMIT);
    let selected: Vec<&str> = content.lines().skip(start).take(max_lines).collect();
    Ok(ReadResult {
        content: selected.join("\n"),
        size_bytes: size,
        total_lines,
        offset: start,
    })
}

pub fn list(
    workspace_root: &Path,
    relative: &str,
    recursive: bool,
) -> Result<Vec<crate::walk::FileEntry>, String> {
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
    if recursive {
        let mut walked = walk_files(&path, prefix);
        walked.files.truncate(MAX_LIST_ENTRIES);
        return Ok(walked.files);
    }
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
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

pub fn write(workspace_root: &Path, relative: &str, content: &str) -> Result<u64, String> {
    let content_bytes = content.as_bytes();
    if content_bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "content too large for write: {} bytes (limit {MAX_WRITE_BYTES})",
            content_bytes.len()
        ));
    }
    let path = resolve_in_workspace(workspace_root, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(content_bytes.len() as u64)
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
        write(&root, "docs/note.txt", "你好工作区").unwrap();
        let read = read(&root, "docs/note.txt", None, None).unwrap();
        assert_eq!(read.content, "你好工作区");
        assert_eq!(read.total_lines, 1);
        let entries = list(&root, ".", false).unwrap();
        assert_eq!(entries[0].path, "docs");
        assert_eq!(entries[0].kind, "dir");
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
        write(&root, "w.txt", body).unwrap();
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
    fn recursive_list_walks_nested_dirs() {
        let root = temp_workspace("recursive");
        write(&root, "src/deep/mod.rs", "fn main() {}").unwrap();
        write(&root, "README.md", "# hi").unwrap();
        let entries = list(&root, ".", true).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md", "src/deep/mod.rs"]);
        let sub = list(&root, "src", true).unwrap();
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].path, "src/deep/mod.rs");
        fs::remove_dir_all(&root).ok();
    }
}
