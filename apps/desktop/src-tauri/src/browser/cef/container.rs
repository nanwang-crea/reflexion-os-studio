//! Own the embedding root and identify Wry's renderer without relying on child order.
use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow};
use std::cell::RefCell;
use tauri::Manager;

#[derive(Clone)]
pub struct Embedding {
    pub root: Retained<NSView>,
    wry_parent: Retained<NSView>,
    pub renderer: Retained<objc2_web_kit::WKWebView>,
}
thread_local! { static EMBEDDING: RefCell<Option<Embedding>> = const { RefCell::new(None) }; }

pub fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
    if EMBEDDING.with(|slot| slot.borrow().is_some()) {
        return Ok(());
    }
    let marker = MainThreadMarker::new().ok_or("CEF requires main thread")?;
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    unsafe {
        let native = &*(window
            .ns_window()
            .map_err(|_| "native window unavailable")? as *const NSWindow);
        let wry_parent = native.contentView().ok_or("renderer unavailable")?;
        let renderer = wry_parent
            .subviews()
            .iter()
            .find_map(|view| view.downcast::<objc2_web_kit::WKWebView>().ok())
            .ok_or("renderer unavailable")?;
        trace("before-reparent", &wry_parent);
        let root = NSView::initWithFrame(NSView::alloc(marker), wry_parent.frame());
        root.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        native.setContentView(Some(&root));
        wry_parent.setFrame(root.bounds());
        root.addSubview(&wry_parent);
        trace("after-reparent", &wry_parent);
        EMBEDDING.with(|slot| {
            *slot.borrow_mut() = Some(Embedding {
                root,
                wry_parent,
                renderer,
            })
        });
    }
    Ok(())
}

/// Clone bounded owners before AppKit calls, which may synchronously invoke callbacks.
pub fn current(app: &tauri::AppHandle) -> Result<Embedding, String> {
    let embedding = EMBEDDING
        .with(|slot| slot.borrow().clone())
        .ok_or("browser embedding unavailable")?;
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let native = window
        .ns_window()
        .map_err(|_| "native window unavailable")?;
    let content = unsafe { (&*(native as *const NSWindow)).contentView() }
        .ok_or("native view unavailable")?;
    if !std::ptr::eq(&*content, &*embedding.root) {
        return Err("browser embedding is no longer the window content".into());
    }
    Ok(embedding)
}

pub fn dispose() {
    // Dropping native owners may reenter AppKit; never do it under a RefCell borrow.
    let embedding = EMBEDDING.with(|slot| slot.borrow_mut().take());
    drop(embedding);
}

/// Restore the exact original Wry container before its normal window teardown.
pub fn restore_wry(app: &tauri::AppHandle) {
    let Ok(embedding) = current(app) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(native) = window.ns_window() else {
        return;
    };
    trace("before-restore", &embedding.wry_parent);
    embedding.wry_parent.removeFromSuperview();
    unsafe { (&*(native as *const NSWindow)).setContentView(Some(&embedding.wry_parent)) };
    trace("after-restore", &embedding.wry_parent);
    dispose();
}

pub fn trace(stage: &str, view: &NSView) {
    if std::env::var_os("REFLEXION_TRACE_NATIVE").is_some() {
        let count: usize = unsafe { objc2::msg_send![view, retainCount] };
        eprintln!("[native-owner] {stage} ptr={:p} refs={count}", view);
    }
}
