//! macOS CEF keychain-mode preference: the only browser flag the host owns on
//! disk, because CEF initializes before the frontend or Runtime can configure it.
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "browser-keychain.json";

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    mock_keychain: bool,
}

/// Dev builds default to the mock keychain so rebuilds never re-prompt for
/// "Chromium Safe Storage"; release builds default to the real keychain.
pub fn default_mock() -> bool {
    cfg!(target_os = "macos") && cfg!(debug_assertions)
}

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "host data directory unavailable".to_string())
        .map(|dir| dir.join(FILE_NAME))
}

fn read(path: &std::path::Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Stored>(&bytes)
            .map(|stored| stored.mock_keychain)
            .unwrap_or_else(|_| {
                crate::logging::write("[browser] invalid browser-keychain.json; using default");
                default_mock()
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => default_mock(),
        Err(_) => default_mock(),
    }
}

fn write(path: &std::path::Path, mock: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "host data directory unavailable".to_string())?;
    }
    let bytes = serde_json::to_vec(&Stored {
        mock_keychain: mock,
    })
    .map_err(|_| "keychain preference serialization failed".to_string())?;
    std::fs::write(path, bytes).map_err(|_| "keychain preference write failed".to_string())
}

pub fn mock_enabled(app: &AppHandle) -> bool {
    path(app)
        .map(|path| read(&path))
        .unwrap_or_else(|_| default_mock())
}

pub fn set_mock_enabled(app: &AppHandle, mock: bool) -> Result<(), String> {
    write(&path(app)?, mock)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "browser-keychain-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn missing_file_falls_back_to_default() {
        assert_eq!(read(&temp_path("missing")), default_mock());
    }

    #[test]
    fn stored_value_round_trips_and_rejects_invalid_content() {
        let path = temp_path("roundtrip");
        write(&path, true).unwrap();
        assert!(read(&path));
        write(&path, false).unwrap();
        assert!(!read(&path));
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(read(&path), default_mock());
        std::fs::remove_file(&path).unwrap();
    }
}
