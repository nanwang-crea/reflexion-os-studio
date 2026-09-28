//! 工作区目录监听：仅监听调用方显式登记的单层目录，路径先过 workspace 边界。

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::filesystem::paths::resolve_in_workspace;
use crate::protocol::emit;

struct Registration {
    _watcher: RecommendedWatcher,
}

fn registrations() -> &'static Mutex<HashMap<String, Registration>> {
    static REGISTRATIONS: OnceLock<Mutex<HashMap<String, Registration>>> = OnceLock::new();
    REGISTRATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn watch(root: &Path, relative: &str, watch_id: &str) -> Result<(), String> {
    if watch_id.trim().is_empty() {
        return Err("watchId must not be empty".to_string());
    }
    let directory = resolve_in_workspace(root, relative)?;
    if !directory.is_dir() {
        return Err(format!("watch target is not a directory: {relative}"));
    }
    let id = watch_id.to_string();
    let event_id = id.clone();
    let workspace_root = root.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let Ok(event) = result else {
            return;
        };
        let kind = format!("{:?}", event.kind);
        for changed_path in event.paths {
            let Some(relative_path) = workspace_relative_path(&workspace_root, &changed_path)
            else {
                continue;
            };
            emit(json!({
                "jsonrpc": "2.0",
                "method": "file.changed",
                "params": {
                    "watchId": event_id,
                    "path": relative_path,
                    "kind": kind,
                }
            }));
        }
    })
    .map_err(|error| format!("create watcher failed: {error}"))?;
    watcher
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(|error| format!("watch directory failed: {error}"))?;
    let mut active = registrations()
        .lock()
        .map_err(|_| "watch registry unavailable".to_string())?;
    active.insert(id, Registration { _watcher: watcher });
    Ok(())
}

fn workspace_relative_path(root: &Path, changed: &Path) -> Option<String> {
    let relative = changed.strip_prefix(root).ok()?;
    let parts = relative
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect::<Option<Vec<_>>>()?;
    if parts.is_empty() {
        Some(".".to_string())
    } else {
        Some(parts.join("/"))
    }
}

pub fn unwatch(watch_id: &str) -> bool {
    registrations()
        .lock()
        .map(|mut active| active.remove(watch_id).is_some())
        .unwrap_or(false)
}

pub fn stop_all() {
    if let Ok(mut active) = registrations().lock() {
        active.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn watch_is_workspace_scoped_and_removable() {
        let root = std::env::temp_dir().join(format!(
            "reflexion-watch-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        assert!(watch(&root, "../outside", "escape").is_err());
        watch(&root, "src", "watch-1").unwrap();
        assert!(unwatch("watch-1"));
        assert!(!unwatch("watch-1"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn changed_paths_are_workspace_relative() {
        let root = Path::new("workspace");
        assert_eq!(
            workspace_relative_path(root, &root.join("src").join("main.rs")),
            Some("src/main.rs".to_string())
        );
        assert_eq!(
            workspace_relative_path(root, Path::new("outside").join("main.rs").as_path()),
            None
        );
    }
}
