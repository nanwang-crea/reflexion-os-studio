//! Parent close is permitted only after every native child acknowledged destruction.
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
#[derive(Default)]
struct State {
    closing: bool,
    browsers: HashSet<u32>,
    finalizing: bool,
}
impl State {
    fn finishable(&mut self) -> bool {
        if self.closing && self.browsers.is_empty() && !self.finalizing {
            self.finalizing = true;
            true
        } else {
            false
        }
    }
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
}
pub fn parent_close_allowed() -> bool {
    state().lock().unwrap_or_else(|e| e.into_inner()).finalizing
}
pub fn window_closed(app: tauri::AppHandle) {
    super::pump::defer(move || {
        #[cfg(target_os = "macos")]
        super::container::dispose();
        super::stop();
        app.exit(0);
    });
}
pub fn closing() -> bool {
    state().lock().unwrap_or_else(|e| e.into_inner()).closing
}
pub fn created(id: u32) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .browsers
        .insert(id);
}
pub fn closed(app: tauri::AppHandle, id: u32) {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .browsers
        .remove(&id);
    finish(app);
}
pub fn request(app: tauri::AppHandle) {
    {
        let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
        if state.closing {
            return;
        }
        state.closing = true;
    }
    super::pump::defer(move || {
        super::dispose();
        finish(app);
    });
}
fn finish(app: tauri::AppHandle) {
    if state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .finishable()
    {
        super::pump::defer(move || {
            // CEF pages and their containers are gone. Detach Wry's renderer
            // subtree first so WryWebViewParent deallocs without a superview
            // during teardown, then let Tauri destroy its own renderer while
            // Chromium's Cocoa integration is still alive.
            #[cfg(target_os = "macos")]
            super::container::detach_wry();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            } else {
                window_closed(app);
            }
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_waits_for_all_children_and_finalizes_exactly_once() {
        let mut s = State::default();
        s.browsers.extend([1, 2, 3]);
        s.closing = true;
        assert!(!s.finishable());
        s.browsers.remove(&2);
        assert!(!s.finishable());
        s.browsers.remove(&1);
        assert!(!s.finishable());
        s.browsers.remove(&3);
        assert!(s.finishable());
        assert!(!s.finishable());
    }
    #[test]
    fn duplicate_closed_callbacks_do_not_underflow_or_close_a_live_sibling() {
        let mut s = State::default();
        s.browsers.extend([1, 2]);
        s.closing = true;
        s.browsers.remove(&1);
        s.browsers.remove(&1);
        assert!(!s.finishable());
        s.browsers.remove(&2);
        assert!(s.finishable());
    }
    #[test]
    fn closing_a_tab_never_requests_parent_close() {
        let mut s = State::default();
        s.browsers.insert(1);
        s.browsers.remove(&1);
        assert!(!s.finishable());
    }
}
