//! File Service：workspace 内的读取/列表/写入。
//! 路径边界由 paths::resolve_in_workspace 强制；本模块只做能力与体量限制。
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::paths::resolve_in_workspace;

pub const MAX_READ_BYTES: u64 = 512 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 2000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub content: String,
    pub size_bytes: u64,
}

pub fn read(workspace_root: &Path, relative: &str) -> Result<ReadResult, String> {
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
    Ok(ReadResult {
        content,
        size_bytes: size,
    })
}

pub fn list(workspace_root: &Path, relative: &str) -> Result<Vec<FileEntry>, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_dir() {
        return Err(format!("not a directory: {relative}"));
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
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size_bytes: metadata.len(),
        });
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
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
    use std::fs;
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
        let read = read(&root, "docs/note.txt").unwrap();
        assert_eq!(read.content, "你好工作区");
        let entries = list(&root, ".").unwrap();
        assert_eq!(entries[0].name, "docs");
        assert_eq!(entries[0].kind, "dir");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_reading_outside_workspace() {
        let root = temp_workspace("escape");
        assert!(read(&root, "../../Cargo.toml").is_err());
        assert!(read(&root, "missing.txt").is_err());
        fs::remove_dir_all(&root).ok();
    }
}
