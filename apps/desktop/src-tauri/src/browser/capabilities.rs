use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub embedded_available: bool,
    pub system_available: bool,
    pub status: String,
    pub notice: Option<String>,
    pub mock_keychain: bool,
    pub features: serde_json::Value,
}

pub fn report(app: &AppHandle) -> Capabilities {
    report_with(super::keychain::mock_enabled(app))
}

pub fn report_with(mock_keychain: bool) -> Capabilities {
    let embedded_available = super::platform::available();
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    let status = if embedded_available {
        "available"
    } else {
        "degraded"
    };
    let notice = if embedded_available {
        None
    } else {
        Some(super::platform::unavailable_notice().into())
    };
    Capabilities {
        platform: platform.into(),
        embedded_available,
        system_available: true,
        status: status.into(),
        notice,
        mock_keychain,
        features: serde_json::json!({
            "find": embedded_available, "zoom": embedded_available, "print": embedded_available,
            "persistentSession": super::platform::persistent_available(), "dataClearing": embedded_available,
            "downloads": embedded_available, "passwordManagement": embedded_available && cfg!(all(feature="browser-spike",target_os="macos")), "contactFill": embedded_available
        }),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn capability_report_matches_platform_in_all_build_profiles() {
        let report = super::report_with(false);
        assert_eq!(
            report.embedded_available,
            super::super::platform::available()
        );
        #[cfg(not(any(
            target_os = "macos",
            all(target_os = "windows", feature = "cef-browser")
        )))]
        {
            assert!(!report.embedded_available);
            assert_eq!(report.features["persistentSession"], false);
            assert_eq!(report.features["passwordManagement"], false);
            let snapshot = crate::browser::state::BrowserState::default()
                .snapshot
                .into_inner()
                .unwrap();
            assert_eq!(snapshot.status, "unavailable");
            assert!(snapshot.tabs.is_empty());
            assert!(report.system_available);
        }
        assert_eq!(report.features["downloads"], report.embedded_available);
    }
}
