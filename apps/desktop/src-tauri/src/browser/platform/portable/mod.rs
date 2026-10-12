//! Shared lifecycle for native WebView2/WebKitGTK guests. No Tauri IPC is installed.
pub(super) mod clearing;
pub(super) mod contact;
pub(super) mod downloads;
pub(super) mod popup;
mod registry;
pub use clearing::clear_data;
pub use registry::{attach, close_tab, control, dispose};

pub fn clearing() -> bool {
    clearing::active()
}

pub(super) use super::guest_registry::{Bounds, Engine};
use tauri::AppHandle;

pub(super) fn navigation_allowed(app: &AppHandle, url: &str) -> bool {
    url == "about:blank"
        || crate::browser::policy::guest_url(url, crate::browser::policy::dev_url(app)).is_ok()
}

pub(super) use super::guest_state::loading;
