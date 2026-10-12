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

use crate::browser::{state::Action, state::Tab};
use tauri::AppHandle;

pub(super) trait Engine {
    fn control(&self, action: &Action) -> Result<(), String>;
    fn layout(&self, bounds: Bounds, visible: bool) -> Result<(), String>;
    fn stop(&self);
}

#[derive(Clone, Copy, Default)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(super) fn navigation_allowed(app: &AppHandle, url: &str) -> bool {
    url == "about:blank"
        || crate::browser::policy::guest_url(url, crate::browser::policy::dev_url(app)).is_ok()
}

pub(super) fn loading(tab: &mut Tab, url: &str, finished: bool) {
    // about:blank is an engine-internal starting page, never a visited page.
    if crate::browser::policy::web_url(url).is_err() {
        return;
    }
    tab.url = Some(url.into());
    tab.status = if finished { "ready" } else { "loading" }.into();
    tab.progress = if finished { 0.0 } else { tab.progress.max(0.1) };
    tab.notice = None;
}

#[cfg(test)]
mod tests {
    #[test]
    fn blank_never_replaces_web_url_and_redirect_preserves_actual_protocol() {
        let mut snapshot = crate::browser::state::BrowserState::default()
            .snapshot
            .into_inner()
            .unwrap();
        snapshot
            .add_tab(Some("http://example.test/".into()))
            .unwrap();
        let tab = &mut snapshot.tabs[0];
        super::loading(tab, "about:blank", false);
        assert_eq!(tab.url.as_deref(), Some("http://example.test/"));
        super::loading(tab, "https://example.test/", true);
        assert_eq!(tab.status, "ready");
        assert_eq!(tab.url.as_deref(), Some("https://example.test/"));
    }
}
