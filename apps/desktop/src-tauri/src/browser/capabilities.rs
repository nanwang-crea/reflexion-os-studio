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
        Some("内嵌浏览器适配器尚未在当前构建与平台完成隔离验证，将回退到系统浏览器".into())
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
