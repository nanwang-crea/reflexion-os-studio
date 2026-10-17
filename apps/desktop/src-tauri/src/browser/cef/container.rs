//! Own the embedding root independently from Wry's renderer parent.
use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow};
use std::cell::RefCell;
use tauri::Manager;
thread_local! { static ROOT: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) }; }
pub fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
    if ROOT.with(|root| root.borrow().is_some()) {
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
        let renderer_parent = native.contentView().ok_or("renderer unavailable")?;
        trace("before-reparent", &renderer_parent);
        let root = NSView::initWithFrame(NSView::alloc(marker), renderer_parent.frame());
        root.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // Keep the old content retained across reparenting. Wry still owns its
        // parent, and the new root's subview list owns the embedding reference.
        native.setContentView(Some(&root));
        renderer_parent.setFrame(root.bounds());
        root.addSubview(&renderer_parent);
        trace("after-reparent", &renderer_parent);
        ROOT.with(|slot| *slot.borrow_mut() = Some(root));
    }
    Ok(())
}
pub fn dispose() {
    ROOT.with(|root| {
        root.borrow_mut().take();
    });
}

/// Detach Wry's renderer subtree from the embedding root before Tauri destroys
/// its window: WryWebViewParent must reach dealloc without a superview, or
/// AppKit raises its over-release assertion during teardown.
pub fn detach_wry() {
    ROOT.with(|root| {
        let binding = root.borrow();
        let Some(root) = binding.as_ref() else {
            return;
        };
        let subviews = root.subviews();
        for index in 0..subviews.count() {
            let view = subviews.objectAtIndex(index);
            trace("before-detach", &view);
            view.removeFromSuperview();
        }
    });
}

pub fn trace(stage: &str, view: &NSView) {
    if std::env::var_os("REFLEXION_TRACE_NATIVE").is_some() {
        let count: usize = unsafe { objc2::msg_send![view, retainCount] };
        eprintln!("[native-owner] {stage} ptr={:p} refs={count}", view);
    }
}
