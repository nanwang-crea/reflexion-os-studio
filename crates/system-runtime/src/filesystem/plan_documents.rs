//! Narrow plan-file capability. No caller-provided path; links and stale writes fail closed.
use super::sha256::hex_digest;
use crate::protocol::{workspace_root, OpError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 100_000;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    workspace_root: String,
    plan_id: String,
    action: String,
    content: Option<String>,
    expected_sha256: Option<String>,
}
fn failure(message: impl ToString) -> OpError {
    OpError::new("plan_document_error", message.to_string())
}
fn target(root: &Path, id: &str) -> Result<PathBuf, OpError> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(failure("invalid plan id"));
    }
    let mut path = root.to_path_buf();
    for name in [".reflexion-studio", "plans", &format!("{id}.md")] {
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(failure("plan path must not contain symlinks"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(error)),
        }
    }
    Ok(path)
}
fn read(path: &Path) -> Result<Option<String>, OpError> {
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() || meta.len() > MAX_BYTES as u64 => {
            return Err(failure("invalid or oversized plan file"))
        }
        Ok(_) => fs::read_to_string(path).map(Some).map_err(failure),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure(error)),
    }
}
pub fn handle(params: Value) -> Result<Value, OpError> {
    let params: Params = serde_json::from_value(params).map_err(failure)?;
    let root = workspace_root(&params.workspace_root)?;
    let path = target(&root, &params.plan_id)?;
    let current = read(&path)?;
    let digest = current.as_ref().map(|text| hex_digest(text.as_bytes()));
    match params.action.as_str() {
        "read" => Ok(json!({"content": current, "sha256": digest})),
        "delete" => {
            if current.is_none() {
                return Ok(json!({"state": "deleted"}));
            }
            if params.expected_sha256.is_none() || digest != params.expected_sha256 {
                return Ok(json!({"state": "preserved"}));
            }
            fs::remove_file(path).map_err(failure)?;
            Ok(json!({"state": "deleted"}))
        }
        "write" => {
            let content = params.content.ok_or_else(|| failure("content required"))?;
            if content.trim().is_empty() || content.len() > MAX_BYTES {
                return Err(failure("empty or oversized plan"));
            }
            if current.is_some()
                && (params.expected_sha256.is_none() || digest != params.expected_sha256)
            {
                return Err(failure(
                    "plan changed since last review; read before revising",
                ));
            }
            if current.is_none() && params.expected_sha256.is_some() {
                return Err(failure("plan file was removed"));
            }
            fs::create_dir_all(path.parent().unwrap()).map_err(failure)?;
            target(&root, &params.plan_id)?;
            let ignore = path.parent().unwrap().join(".gitignore");
            match fs::symlink_metadata(&ignore) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(failure("plan ignore file is a symlink"))
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(ignore)
                        .map_err(failure)?;
                    file.write_all(b"*\n").map_err(failure)?;
                }
                Err(error) => return Err(failure(error)),
            }
            // Reuse the cross-platform atomic replacement for reviewed existing files.
            // New files use exclusive creation so an unregistered file is never overwritten.
            if current.is_some() {
                super::files::atomic_write(&path, content.as_bytes()).map_err(failure)?;
            } else {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(failure)?;
                file.write_all(content.as_bytes()).map_err(failure)?;
                file.sync_all().map_err(failure)?;
            }
            Ok(json!({"sha256": hex_digest(content.as_bytes())}))
        }
        _ => Err(failure("unsupported plan document action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "reflexion-plan-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    #[test]
    fn preserves_user_edits_and_deletes_only_registered_digest() {
        let root = workspace();
        let saved = handle(
            json!({"workspaceRoot": root, "planId": ID, "action": "write", "content": "first"}),
        )
        .unwrap();
        let path = target(&root, ID).unwrap();
        fs::write(&path, "user edit").unwrap();
        assert!(handle(json!({"workspaceRoot": root, "planId": ID, "action": "write", "content": "overwrite", "expectedSha256": saved["sha256"]})).is_err());
        assert_eq!(handle(json!({"workspaceRoot": root, "planId": ID, "action": "delete", "expectedSha256": saved["sha256"]})).unwrap()["state"], "preserved");
        assert_eq!(fs::read_to_string(&path).unwrap(), "user edit");
        assert_eq!(handle(json!({"workspaceRoot": root, "planId": ID, "action": "delete", "expectedSha256": hex_digest(b"user edit")})).unwrap()["state"], "deleted");
        assert!(root.join(".reflexion-studio/plans/.gitignore").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_traversal_and_existing_unregistered_files() {
        let root = workspace();
        assert!(target(&root, "../../anything").is_err());
        let path = target(&root, ID).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "owned by user").unwrap();
        assert!(handle(
            json!({"workspaceRoot": root, "planId": ID, "action": "write", "content": "replace"})
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_even_inside_workspace() {
        let root = workspace();
        fs::create_dir(root.join("notes")).unwrap();
        std::os::unix::fs::symlink(root.join("notes"), root.join(".reflexion-studio")).unwrap();
        assert!(target(&root, ID).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
