//! Browser creation and popup cancellation must never nest inside CEF callbacks.
use crate::browser::{state::Action, window};
use cef::ImplFrame;
pub fn open(app: tauri::AppHandle, opener: u32, url: String) {
    super::pump::defer(move || {
        if super::accepting() && super::registry::popup_allowed(opener) {
            let _ = window::control(&app, Action::Newtab { url: Some(url) });
        }
    });
}

/// A leased Agent page keeps popup navigation inside its visible owned tab.
pub fn follow(frame: cef::Frame, url: String, policy: std::sync::Arc<super::registry::Policy>) {
    super::pump::defer(move || {
        if super::accepting() && frame.is_valid() == 1 && policy.allows_navigation(&url, "GET") {
            frame.load_url(Some(&cef::CefString::from(url.as_str())));
        }
    });
}
