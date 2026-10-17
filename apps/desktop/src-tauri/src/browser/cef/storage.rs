//! Profile generations reset all website storage (not just cookies) without reusing it.
use std::path::{Path, PathBuf};
use tauri::Manager;
fn generation(path: &Path) -> Option<u64> {
    path.file_name()?
        .to_str()?
        .strip_prefix("user-")?
        .parse()
        .ok()
}
fn latest(root: &Path) -> Result<u64, String> {
    let mut current = 0;
    for entry in std::fs::read_dir(root).map_err(|_| "CEF profile directory unavailable")? {
        let entry = entry.map_err(|_| "CEF profile directory unavailable")?;
        if let Some(id) = generation(&entry.path()) {
            if !entry
                .file_type()
                .map_err(|_| "CEF profile unavailable")?
                .is_dir()
            {
                return Err("CEF profile must not be a link".into());
            }
            current = current.max(id);
        }
    }
    Ok(current)
}
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "CEF cache unavailable")?
        .join("cef"))
}
pub fn user(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = root(app)?;
    let id = latest(&root)?;
    if id == 0 {
        rotate_at(&root)
    } else {
        Ok(root.join(format!("user-{id}")))
    }
}
fn rotate_at(root: &Path) -> Result<PathBuf, String> {
    for _ in 0..16 {
        let next = latest(root)?
            .checked_add(1)
            .ok_or("CEF profile generation exhausted")?;
        let path = root.join(format!("user-{next}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("CEF profile reset failed".into()),
        }
    }
    Err("CEF profile reset busy".into())
}
pub fn rotate(app: &tauri::AppHandle) -> Result<(), String> {
    rotate_at(&root(app)?)?;
    Ok(())
}
/// Run before initializing CEF, when no profile is held open by Chromium.
pub fn collect(root: &Path) -> Result<(), String> {
    let current = latest(root)?;
    for entry in std::fs::read_dir(root).map_err(|_| "CEF profile cleanup unavailable")? {
        let entry = entry.map_err(|_| "CEF profile cleanup unavailable")?;
        if generation(&entry.path()).is_some_and(|id| id < current)
            && entry
                .file_type()
                .map_err(|_| "CEF profile cleanup unavailable")?
                .is_dir()
        {
            std::fs::remove_dir_all(entry.path())
                .map_err(|_| "CEF retired profile cleanup failed")?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_never_reuses_old_website_storage() {
        let root = std::env::temp_dir().join(format!(
            "cef-generation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let first = rotate_at(&root).unwrap();
        std::fs::write(first.join("synthetic-storage"), "test").unwrap();
        let next = rotate_at(&root).unwrap();
        assert_ne!(first, next);
        assert_eq!(latest(&root).unwrap(), 2);
        collect(&root).unwrap();
        assert!(!first.exists());
        assert!(next.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
