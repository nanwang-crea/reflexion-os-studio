//! Workspace 内的写类操作：edit / delete / move / mkdir。
//! grant 检查由 main.rs 分发层完成；本模块负责路径边界、体量上限与语义校验。
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::files::MAX_WRITE_BYTES;
use crate::paths::resolve_in_workspace;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

fn changed(path: &str, action: &str) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        action: action.to_string(),
        old_path: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    pub replaced_count: usize,
    pub size_bytes: u64,
    /// 编辑后的新 mtime（毫秒），调用方记入读取状态供后续编辑使用。
    pub modified_ms: u64,
    /// 编辑后完整内容的 revision 凭据（mtime+size+sha256）。
    pub revision: crate::files::Revision,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub kind: String,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub from: String,
    pub to: String,
    pub changed_files: Vec<ChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirOutcome {
    pub path: String,
    pub changed_files: Vec<ChangedFile>,
}

/// 精确替换：oldText 出现次数必须等于 expected（默认 1），否则报错不写入。
/// 相比整文件重写，模型只需提交被替换片段，省 token 且不受 2MB 写入上限影响。
/// 编辑必须携带 readToken（一次 file.read 的 mtime 凭据）：强制先读后写，
/// 并检出读取与编辑之间文件被外部修改的情况。
/// CRLF 容错：file.read 输出按 \n 归一化，模型复制的片段在 \r\n 文件上无法
/// 精确匹配；精确匹配未命中时按归一化重试，命中后按原文件行尾写回。
pub fn edit(
    workspace_root: &Path,
    relative: &str,
    old_text: &str,
    new_text: &str,
    expected: Option<usize>,
    revision: Option<crate::files::Revision>,
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
    let token = revision.ok_or_else(|| {
        format!("file.edit requires readToken: run file.read on '{relative}' first")
    })?;
    let current_ms = crate::files::mtime_ms(&path)?;
    if current_ms != token.modified_ms {
        return Err(format!(
            "file changed since last read (mtime {current_ms} != revision {}); \
             re-run file.read on '{relative}' before editing",
            token.modified_ms
        ));
    }
    if size != token.size_bytes {
        return Err(format!(
            "file changed since last read (size {size} != revision {}); \
             re-run file.read on '{relative}' before editing",
            token.size_bytes
        ));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let current_sha256 = crate::sha256::hex_digest(content.as_bytes());
    if current_sha256 != token.sha256 {
        return Err(format!(
            "file content changed since last read (same mtime but sha256 mismatch); \
             re-run file.read on '{relative}' before editing"
        ));
    }
    let raw_count = content.matches(old_text).count();
    let (updated, replaced_count) = if raw_count == expected {
        (content.replace(old_text, new_text), expected)
    } else {
        replace_with_normalized_eol(&content, old_text, new_text, expected, raw_count)?
    };
    crate::files::atomic_write(&path, updated.as_bytes())?;
    let modified_ms = crate::files::mtime_ms(&path)?;
    let size_bytes = updated.len() as u64;
    Ok(EditOutcome {
        replaced_count,
        size_bytes,
        modified_ms,
        revision: crate::files::Revision {
            modified_ms,
            size_bytes,
            sha256: crate::sha256::hex_digest(updated.as_bytes()),
        },
        changed_files: vec![changed(relative, "modified")],
    })
}

/// CRLF 归一化替换回退：两侧 \r\n → \n 后重新匹配（BOM 不参与匹配，写回时
/// 保留在文件头）。命中则替换，并按原文件行尾风格整体恢复——含 \r\n 的文件
/// 统一恢复 CRLF，纯 LF 文件保持 \n（混合行尾文件借此归一，属可接受副作用）。
/// 仍未命中时返回带两种计数的诊断错误，引导模型重新读取。
fn replace_with_normalized_eol(
    content: &str,
    old_text: &str,
    new_text: &str,
    expected: usize,
    raw_count: usize,
) -> Result<(String, usize), String> {
    let (bom, body) = match content.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, content),
    };
    let normalized = body.replace("\r\n", "\n");
    let old_normalized = old_text.replace("\r\n", "\n");
    let new_normalized = new_text.replace("\r\n", "\n");
    let normalized_count = normalized.matches(old_normalized.as_str()).count();
    if normalized_count != expected {
        return Err(format!(
            "oldText appears {raw_count} time(s) exactly and {normalized_count} time(s) with \
             CRLF-normalized matching, expectedCount is {expected}; no changes written. \
             Re-read the file and copy oldText from its current content."
        ));
    }
    let mut updated = normalized.replace(old_normalized.as_str(), new_normalized.as_str());
    if bom {
        updated.insert(0, '\u{feff}');
    }
    if content.contains("\r\n") {
        updated = updated.replace('\n', "\r\n");
    }
    Ok((updated, expected))
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
            changed_files: vec![changed(relative, "deleted")],
        })
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        Ok(DeleteOutcome {
            kind: "file".to_string(),
            changed_files: vec![changed(relative, "deleted")],
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
        changed_files: vec![ChangedFile {
            path: to.to_string(),
            action: "moved".to_string(),
            old_path: Some(from.to_string()),
        }],
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
        changed_files: vec![changed(relative, "created")],
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
        let read = crate::files::read(&root, "a.txt", None, None).unwrap();
        let token = crate::files::Revision {
            modified_ms: read.modified_ms,
            size_bytes: read.size_bytes,
            sha256: read.content_sha256,
        };
        let ok = edit(&root, "a.txt", "fee", "foo", Some(2), Some(token.clone())).unwrap();
        assert_eq!(ok.replaced_count, 2);
        assert_eq!(ok.changed_files[0].action, "modified");
        assert_eq!(ok.changed_files[0].path, "a.txt");
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "foo foo fi"
        );
        // 陈旧凭据：mtime 或内容任一不再匹配都被拒绝。
        let stale_mtime = crate::files::Revision {
            modified_ms: token.modified_ms.wrapping_add(1),
            ..token.clone()
        };
        assert!(edit(&root, "a.txt", "foo", "bar", Some(1), Some(stale_mtime)).is_err());
        let stale_sha = crate::files::Revision {
            sha256: "0".repeat(64),
            ..token
        };
        assert!(edit(&root, "a.txt", "foo", "bar", Some(1), Some(stale_sha)).is_err());
        // 写入方返回的新凭据可直接继续编辑（链式工作流）。
        let chain = edit(&root, "a.txt", "foo", "fee", Some(2), Some(ok.revision)).unwrap();
        assert_eq!(chain.replaced_count, 2);
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "fee fee fi"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edit_requires_read_token() {
        let root = temp_workspace("edit-token");
        fs::write(root.join("a.txt"), "hello").unwrap();
        assert!(edit(&root, "a.txt", "hello", "hi", None, None).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edit_matches_crlf_files_with_normalized_eol() {
        let root = temp_workspace("edit-crlf");
        fs::write(root.join("c.txt"), "alpha\r\nbeta\r\ngamma\r\n").unwrap();
        let read = crate::files::read(&root, "c.txt", None, None).unwrap();
        let token = crate::files::Revision {
            modified_ms: read.modified_ms,
            size_bytes: read.size_bytes,
            sha256: read.content_sha256,
        };
        // oldText 来自 file.read 的 \n 归一化输出，精确匹配为 0，容错路径命中。
        let outcome = edit(&root, "c.txt", "beta", "delta", None, Some(token)).unwrap();
        assert_eq!(outcome.replaced_count, 1);
        assert_eq!(
            fs::read_to_string(root.join("c.txt")).unwrap(),
            "alpha\r\ndelta\r\ngamma\r\n"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edit_preserves_bom_and_lf_files() {
        let root = temp_workspace("edit-bom");
        fs::write(root.join("b.txt"), "\u{feff}one\ntwo\n").unwrap();
        let read = crate::files::read(&root, "b.txt", None, None).unwrap();
        let token = crate::files::Revision {
            modified_ms: read.modified_ms,
            size_bytes: read.size_bytes,
            sha256: read.content_sha256,
        };
        // BOM 文件首行匹配（模型拿到的内容含 BOM 字符，此处模拟不含 BOM 的复制）。
        let outcome = edit(&root, "b.txt", "two", "TWO", None, Some(token)).unwrap();
        assert_eq!(outcome.replaced_count, 1);
        assert_eq!(
            fs::read_to_string(root.join("b.txt")).unwrap(),
            "\u{feff}one\nTWO\n"
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
