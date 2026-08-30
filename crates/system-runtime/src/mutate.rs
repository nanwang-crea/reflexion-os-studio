//! Workspace 内的写类操作：edit / delete / move / mkdir。
//! grant 检查由 main.rs 分发层完成；本模块负责路径边界、体量上限与语义校验。
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::files::MAX_WRITE_BYTES;
use crate::paths::resolve_in_workspace;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub replaced_count: usize,
    pub size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirOutcome {
    pub path: String,
}

/// 精确替换：oldText 出现次数必须等于 expected（默认 1），否则报错不写入。
/// 相比整文件重写，模型只需提交被替换片段，省 token 且不受 2MB 写入上限影响。
pub fn edit(
    workspace_root: &Path,
    relative: &str,
    old_text: &str,
    new_text: &str,
    expected: Option<usize>,
) -> Result<EditOutcome, String> {
    if old_text.is_empty() {
        return Err("oldText must not be empty".to_string());
    }
    let expected = expected.unwrap_or(1).max(1);
    let path = resolve_in_workspace(workspace_root, relative)?;
    if !path.is_file() {
        return Err(format!("not a regular file: {relative}"));
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_WRITE_BYTES as u64 {
        return Err(format!(
            "file too large for edit: {size} bytes (limit {MAX_WRITE_BYTES})"
        ));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let count = content.matches(old_text).count();
    if count != expected {
        return Err(format!(
            "oldText appears {count} time(s) but expectedCount is {expected}; no changes written"
        ));
    }
    let updated = content.replace(old_text, new_text);
    fs::write(&path, &updated).map_err(|e| e.to_string())?;
    Ok(EditOutcome {
        replaced_count: count,
        size_bytes: updated.len() as u64,
    })
}

pub fn delete(workspace_root: &Path, relative: &str) -> Result<DeleteOutcome, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    let canonical_root = workspace_root
        .canonicalize()
        .map_err(|error| format!("workspace root invalid: {error}"))?;
    if path == canonical_root {
        return Err("refusing to delete the workspace root".to_string());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(DeleteOutcome {
            kind: "dir".to_string(),
        })
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        Ok(DeleteOutcome {
            kind: "file".to_string(),
        })
    }
}

pub fn move_path(workspace_root: &Path, from: &str, to: &str) -> Result<MoveOutcome, String> {
    let source = resolve_in_workspace(workspace_root, from)?;
    if !source.exists() {
        return Err(format!("source not found: {from}"));
    }
    let target = resolve_in_workspace(workspace_root, to)?;
    if target.exists() {
        return Err(format!("destination already exists: {to}"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&source, &target).map_err(|e| e.to_string())?;
    Ok(MoveOutcome {
        from: from.to_string(),
        to: to.to_string(),
    })
}

pub fn mkdir(workspace_root: &Path, relative: &str) -> Result<MkdirOutcome, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    if path.is_file() {
        return Err(format!("a file already exists at: {relative}"));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(MkdirOutcome {
        path: relative.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("reflexion-mutate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn edit_replaces_exact_occurrence_count() {
        let root = temp_workspace("edit");
        fs::write(root.join("a.txt"), "fee fee fi").unwrap();
        let ok = edit(&root, "a.txt", "fee", "foo", Some(2)).unwrap();
        assert_eq!(ok.replaced_count, 2);
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "foo foo fi"
        );
        let mismatch = edit(&root, "a.txt", "fee", "bar", Some(1));
        assert!(mismatch.is_err());
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "foo foo fi"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_refuses_workspace_root_but_removes_files_and_dirs() {
        let root = temp_workspace("delete");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/a.txt"), "a").unwrap();
        assert!(delete(&root, ".").is_err());
        let outcome = delete(&root, "sub").unwrap();
        assert_eq!(outcome.kind, "dir");
        assert!(!root.join("sub").exists());
        fs::write(root.join("b.txt"), "b").unwrap();
        let file_outcome = delete(&root, "b.txt").unwrap();
        assert_eq!(file_outcome.kind, "file");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn move_renames_and_rejects_existing_destination() {
        let root = temp_workspace("move");
        fs::write(root.join("a.txt"), "a").unwrap();
        let outcome = move_path(&root, "a.txt", "sub/b.txt").unwrap();
        assert_eq!(outcome.to, "sub/b.txt");
        assert!(!root.join("a.txt").exists());
        assert_eq!(fs::read_to_string(root.join("sub/b.txt")).unwrap(), "a");
        fs::write(root.join("c.txt"), "c").unwrap();
        assert!(move_path(&root, "c.txt", "sub/b.txt").is_err());
        assert!(move_path(&root, "c.txt", "../../outside.txt").is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mkdir_creates_nested_dirs() {
        let root = temp_workspace("mkdir");
        let outcome = mkdir(&root, "a/b/c").unwrap();
        assert_eq!(outcome.path, "a/b/c");
        assert!(root.join("a/b/c").is_dir());
        assert!(mkdir(&root, "a/b/c").is_ok());
        fs::remove_dir_all(&root).ok();
    }
}
