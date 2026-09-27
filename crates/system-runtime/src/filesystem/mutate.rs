//! Workspace 内非文本 patch 写操作：delete / move / mkdir。
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::paths::resolve_in_workspace;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

pub(crate) fn changed(path: &str, action: &str) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        action: action.to_string(),
        old_path: None,
    }
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

pub fn delete(workspace_root: &Path, relative: &str) -> Result<DeleteOutcome, String> {
    let path = resolve_in_workspace(workspace_root, relative)?;
    let canonical_root = workspace_root
        .canonicalize()
        .map_err(|error| format!("workspace root invalid: {error}"))?;
    if path == canonical_root {
        return Err("refusing to delete the workspace root".to_string());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(DeleteOutcome {
            kind: "dir".to_string(),
            changed_files: vec![changed(relative, "deleted")],
        })
    } else {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
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
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(&source, &target).map_err(|error| error.to_string())?;
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
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(MkdirOutcome {
        path: relative.to_string(),
        changed_files: vec![changed(relative, "created")],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn workspace(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("reflexion-mutate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn delete_move_and_mkdir_stay_inside_workspace() {
        let root = workspace("operations");
        assert!(delete(&root, ".").is_err());
        fs::write(root.join("a.txt"), "a").unwrap();
        assert_eq!(
            move_path(&root, "a.txt", "sub/b.txt").unwrap().to,
            "sub/b.txt"
        );
        assert!(move_path(&root, "sub/b.txt", "../../outside.txt").is_err());
        assert_eq!(mkdir(&root, "one/two").unwrap().path, "one/two");
        assert_eq!(delete(&root, "sub").unwrap().kind, "dir");
        fs::remove_dir_all(root).ok();
    }
}
