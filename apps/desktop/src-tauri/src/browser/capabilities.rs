use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub embedded_available: bool,
    pub system_available: bool,
    pub status: String,
    pub notice: Option<String>,
    pub features: serde_json::Value,
}

pub fn report() -> Capabilities {
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
        features: serde_json::json!({
            "find": embedded_available, "zoom": embedded_available, "print": embedded_available,
            "persistentSession": super::platform::persistent_available(), "dataClearing": embedded_available,
            "downloads": embedded_available, "passwordManagement": embedded_available, "contactFill": embedded_available,
            "sitePermissions": if super::platform::media_available() { vec!["camera", "microphone"] } else { vec![] }
        }),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn capability_report_matches_platform_in_all_build_profiles() {
        let report = super::report();
        assert_eq!(
            report.embedded_available,
            super::super::platform::available()
        );
        #[cfg(all(feature = "browser-spike", target_os = "macos"))]
        assert_eq!(
            report.embedded_available,
            super::super::platform::persistent_available()
                || objc2_foundation::NSProcessInfo::processInfo()
                    .operatingSystemVersion()
                    .majorVersion
                    >= 12
        );
        #[cfg(not(target_os = "macos"))]
        assert!(!report.embedded_available);
        assert_eq!(report.features["downloads"], report.embedded_available);
    }
}
