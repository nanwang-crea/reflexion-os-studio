//! Bounded, UI-selected chat backups. Never overwrite files or follow credential paths.
use crate::protocol::OpError;
use crate::sandbox::sensitive_roots;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    action: String,
    workspace_root: String,
    path: Option<String>,
    content: Option<String>,
}
fn failure(message: impl ToString) -> OpError {
    OpError::new("chat_archive_error", message.to_string())
}
fn allowed(path: &Path) -> Result<(), OpError> {
    for root in sensitive_roots() {
        let root = root.canonicalize().unwrap_or(root);
        if path.starts_with(root) {
            return Err(failure("sensitive archive path denied"));
        }
    }
    for segment in path.components() {
        let name = segment.as_os_str().to_string_lossy().to_lowercase();
        if [
            ".ssh",
            ".aws",
            ".gnupg",
            "pgp",
            ".docker",
            ".npmrc",
            ".netrc",
            "credentials.json",
            "secrets.json",
            "id_token",
        ]
        .contains(&name.as_str())
            || name.starts_with(".env")
            || name.starts_with("id_rsa")
            || name.starts_with("id_ed25519")
            || [".pem", ".key", ".token"]
                .iter()
                .any(|ext| name.ends_with(ext))
        {
            return Err(failure("sensitive archive path denied"));
        }
    }
    Ok(())
}
fn target(root: &Path, name: &str) -> Result<PathBuf, OpError> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || !name.ends_with(".reflexion-chat.json")
        || name.starts_with('.')
    {
        return Err(failure("select a .reflexion-chat.json backup"));
    }
    let path = root.join(name);
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(failure("archive symlinks are not allowed"));
    }
    allowed(&path)?;
    Ok(path)
}
fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(tail) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{tail}");
        }
        if let Some(tail) = value.strip_prefix(r"\\?\") {
            return tail.to_string();
        }
    }
    value
}

pub fn handle(params: Value) -> Result<Value, OpError> {
    let params: Params = serde_json::from_value(params).map_err(failure)?;
    let raw = Path::new(&params.workspace_root);
    if !raw.is_absolute() {
        return Err(failure("archive directory must be absolute"));
    }
    allowed(raw)?;
    let root = raw.canonicalize().map_err(failure)?;
    allowed(&root)?;
    if !root.is_dir() {
        return Err(failure("archive directory does not exist"));
    }
    if params.action == "directory" {
        return Ok(json!({"path": display_path(&root)}));
    }
    let path = target(
        &root,
        params
            .path
            .as_deref()
            .ok_or_else(|| failure("path required"))?,
    )?;
    match params.action.as_str() {
        "read" => {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
            }
            let file = options.open(&path).map_err(failure)?;
            let info = file.metadata().map_err(failure)?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if info.file_attributes() & 0x400 != 0 {
                    return Err(failure("archive reparse point denied"));
                }
            }
            if !info.is_file() || info.len() > MAX_BYTES as u64 {
                return Err(failure("invalid backup or backup exceeds 16MiB"));
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(failure)?;
            if bytes.len() > MAX_BYTES {
                return Err(failure("backup exceeds 16MiB"));
            }
            let content = String::from_utf8(bytes).map_err(|_| failure("backup must be UTF-8"))?;
            Ok(json!({"path": display_path(&path), "content": content}))
        }
        "write" => {
            let content = params.content.ok_or_else(|| failure("content required"))?;
            if content.len() > MAX_BYTES {
                return Err(failure("backup exceeds 16MiB"));
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(failure)?;
            if let Err(error) = file
                .write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
            {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(failure(error));
            }
            Ok(json!({"path": display_path(&path)}))
        }
        _ => Err(failure("unknown archive action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "reflexion-chat-archive-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn round_trip_unicode_and_never_overwrite() {
        let root = root("roundtrip");
        let params = json!({"action":"write","workspaceRoot":root,"path":"chat.reflexion-chat.json","content":"{\"对话\":\"你好🌍\"}"});
        assert!(handle(params.clone()).is_ok());
        assert!(handle(params).is_err());
        let read =
            handle(json!({"action":"read","workspaceRoot":root,"path":"chat.reflexion-chat.json"}))
                .unwrap();
        assert_eq!(read["content"], "{\"对话\":\"你好🌍\"}");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_paths_credentials_and_oversized_archives() {
        let root = root("bounds");
        for name in [
            "../chat.reflexion-chat.json",
            "chat.json",
            ".env.reflexion-chat.json",
            "file:stream.reflexion-chat.json",
        ] {
            assert!(target(&root, name).is_err());
        }
        assert!(allowed(&root.join(".ssh").join("chat.reflexion-chat.json")).is_err());
        let file = fs::File::create(root.join("large.reflexion-chat.json")).unwrap();
        file.set_len((MAX_BYTES + 1) as u64).unwrap();
        assert!(handle(
            json!({"action":"read","workspaceRoot":root,"path":"large.reflexion-chat.json"})
        )
        .is_err());
        assert!(handle(json!({"action":"write","workspaceRoot":root,"path":"huge.reflexion-chat.json","content":"a".repeat(MAX_BYTES+1)})).is_err());
        assert!(!root.join("huge.reflexion-chat.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_even_inside_selected_directory() {
        let root = root("link");
        fs::write(root.join("plain.txt"), "harmless fixture").unwrap();
        std::os::unix::fs::symlink(
            root.join("plain.txt"),
            root.join("link.reflexion-chat.json"),
        )
        .unwrap();
        assert!(handle(
            json!({"action":"read","workspaceRoot":root,"path":"link.reflexion-chat.json"})
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
