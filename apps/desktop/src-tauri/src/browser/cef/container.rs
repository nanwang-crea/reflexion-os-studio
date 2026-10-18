//! Identify Wry's existing views; never replace NSWindow.contentView.
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSView, NSWindow};
use std::cell::RefCell;
use tauri::Manager;

#[derive(Clone)]
pub struct Embedding {
    pub root: Retained<NSView>,
    window: Retained<NSWindow>,
    pub renderer: Retained<objc2_web_kit::WKWebView>,
}
thread_local! { static EMBEDDING: RefCell<Option<Embedding>> = const { RefCell::new(None) }; }

pub fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
    MainThreadMarker::new().ok_or("CEF requires main thread")?;
    if EMBEDDING.with(|slot| slot.borrow().is_some()) {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let native = window
        .ns_window()
        .map_err(|_| "native window unavailable")?;
    let native =
        unsafe { Retained::retain(native as *mut NSWindow) }.ok_or("native window unavailable")?;
    let root_ptr: *mut NSView = unsafe { objc2::msg_send![&*native, contentView] };
    let root = unsafe { Retained::retain(root_ptr) }.ok_or("renderer unavailable")?;
    let renderer = root
        .subviews()
        .iter()
        .find_map(|view| view.downcast::<objc2_web_kit::WKWebView>().ok())
        .ok_or("renderer unavailable")?;
    // CEF's owned GuardView becomes a sibling of WKWebView. Wry and AppKit
    // keep their original parent and window ownership throughout the session.
    trace("original-wry-root", &root);
    EMBEDDING.with(|slot| {
        *slot.borrow_mut() = Some(Embedding {
            root,
            window: native,
            renderer,
        })
    });
    Ok(())
}

/// Clone bounded owners before AppKit calls, which may synchronously invoke callbacks.
pub fn current(_app: &tauri::AppHandle) -> Result<Embedding, String> {
    MainThreadMarker::new().ok_or("CEF requires main thread")?;
    let embedding = EMBEDDING
        .with(|slot| slot.borrow().clone())
        .ok_or("browser embedding unavailable")?;
    // Identity check only: this getter does not transfer ownership.
    let content: *mut NSView = unsafe { objc2::msg_send![&*embedding.window, contentView] };
    if !std::ptr::eq(content, &*embedding.root) {
        return Err("browser embedding is no longer the window content".into());
    }
    Ok(embedding)
}

pub fn dispose() {
    // Drop outside the borrow: native destruction can synchronously reenter.
    let embedding = EMBEDDING.with(|slot| slot.borrow_mut().take());
    drop(embedding);
}

pub fn trace(stage: &str, view: &NSView) {
    if std::env::var_os("REFLEXION_TRACE_NATIVE").is_some() {
        let count: usize = unsafe { objc2::msg_send![view, retainCount] };
        eprintln!("[native-owner] {stage} ptr={:p} refs={count}", view);
    }
}
