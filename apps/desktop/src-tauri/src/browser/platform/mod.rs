#[cfg(any(test, target_os = "windows", target_os = "linux"))]
mod guest_registry;
#[cfg(any(test, target_os = "windows", target_os = "linux"))]
mod guest_state;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(feature = "browser-spike", target_os = "macos"))]
mod macos;
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod portable;
#[cfg(target_os = "windows")]
mod windows;

pub fn available() -> bool {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::supported_version()
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        false
    }
}

#[cfg(all(feature = "browser-spike", target_os = "macos"))]
pub use macos::{attach, close_tab, control, dispose, fill, install_cookies, manage_password};

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub use portable::{attach, close_tab, control, dispose};

#[cfg(not(any(
    all(feature = "browser-spike", target_os = "macos"),
    target_os = "windows",
    target_os = "linux"
)))]
mod unsupported {
    use crate::browser::state::Action;
    use tauri::AppHandle;
    // WebView2: PermissionRequested + file selection/clipboard/profile proof required.
    // WebKitGTK: permission-request + run-file-chooser + ephemeral context proof required.
    // Fail closed instead of exposing a WebView with implicit native permissions.
    pub fn attach(_: &AppHandle) -> Result<(), String> {
        Err("native adapter not verified".into())
    }
    pub fn control(_: &AppHandle, _: &Action) -> Result<(), String> {
        Err("native adapter not verified".into())
    }
    pub fn close_tab(_: u32) {}
    pub fn dispose() {}
}
#[cfg(not(any(
    all(feature = "browser-spike", target_os = "macos"),
    target_os = "windows",
    target_os = "linux"
)))]
pub use unsupported::{attach, close_tab, control, dispose};

pub fn persistent_available() -> bool {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::persistent_available()
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        false
    }
}

pub fn clear_data(
    app: &tauri::AppHandle,
    website_data: bool,
    cache: bool,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::clear_data(app, website_data, cache, done);
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        portable::clear_data(app, website_data, cache, done);
    }
    #[cfg(not(any(
        all(feature = "browser-spike", target_os = "macos"),
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        let _ = (app, website_data, cache);
        let _ = done.send(Err("原生数据清理尚未适配本平台".into()));
    }
}

pub fn downloads() -> Vec<crate::browser::downloads::Record> {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::downloads::list()
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        portable::downloads::list()
    }
    #[cfg(not(any(
        all(feature = "browser-spike", target_os = "macos"),
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        vec![]
    }
}
pub fn download_action(id: u64, kind: &str) -> Result<(), String> {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::downloads::action(id, kind)
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        portable::downloads::action(id, kind)
    }
    #[cfg(not(any(
        all(feature = "browser-spike", target_os = "macos"),
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        let _ = (id, kind);
        Err("下载适配不可用".into())
    }
}

pub fn clearing() -> bool {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::clearing()
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        portable::clearing()
    }
    #[cfg(not(any(
        all(feature = "browser-spike", target_os = "macos"),
        target_os = "windows",
        target_os = "linux"
    )))]
    {
        false
    }
}
pub fn media_available() -> bool {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        available() && macos::media_available()
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        false
    }
}

pub fn unavailable_notice() -> &'static str {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        "内嵌浏览器需要 macOS 12 或更新系统"
    }
    #[cfg(all(not(feature = "browser-spike"), target_os = "macos"))]
    {
        "当前构建已禁用 macOS 内嵌浏览器"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Windows / Linux 内嵌浏览器暂未启用，将使用系统浏览器"
    }
}
