//! Browser creation and popup cancellation must never nest inside CEF callbacks.
use crate::browser::{state::Action, window};
pub fn open(app: tauri::AppHandle, opener: u32, url: String) {
    super::pump::defer(move || {
        if super::accepting() && super::registry::popup_allowed(opener) {
            let _ = window::control(&app, Action::Newtab { url: Some(url) });
        }
    });
}
