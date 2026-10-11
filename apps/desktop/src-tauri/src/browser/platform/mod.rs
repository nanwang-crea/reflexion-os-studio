#[cfg(all(feature = "browser-spike", target_os = "macos"))]
mod macos;

pub fn available() -> bool {
    #[cfg(all(feature = "browser-spike", debug_assertions, target_os = "macos"))]
    {
        macos::supported_version()
    }
    #[cfg(not(all(feature = "browser-spike", debug_assertions, target_os = "macos")))]
    {
        false
    }
}

#[cfg(all(feature = "browser-spike", target_os = "macos"))]
pub use macos::{attach, close_tab, control, dispose, fill, install_cookies};

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
