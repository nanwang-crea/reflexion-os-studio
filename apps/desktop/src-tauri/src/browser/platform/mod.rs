#[cfg(all(feature = "browser-spike", target_os = "macos"))]
mod macos;

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

#[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
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
#[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
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
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
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
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
    {
        vec![]
    }
}
pub fn download_action(id: u64, kind: &str) -> Result<(), String> {
    #[cfg(all(feature = "browser-spike", target_os = "macos"))]
    {
        macos::downloads::action(id, kind)
    }
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
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
    #[cfg(not(all(feature = "browser-spike", target_os = "macos")))]
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
