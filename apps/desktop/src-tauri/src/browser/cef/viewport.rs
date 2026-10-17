use super::registry::{Bounds, Policy};
use cef::*;
use std::sync::Arc;
use tauri::Manager;

pub fn window_info(
    app: &tauri::AppHandle,
    id: u32,
    _policy: Arc<Policy>,
) -> Result<WindowInfo, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    #[cfg(target_os = "macos")]
    let parent = unsafe {
        use objc2_app_kit::NSWindow;
        super::container::ensure(app)?;
        let view = (&*(window
            .ns_window()
            .map_err(|_| "native window unavailable")? as *const NSWindow))
            .contentView()
            .ok_or("native view unavailable")?;
        super::input::create(id, &view, _policy)?
    };
    #[cfg(target_os = "windows")]
    let parent = window.hwnd().map_err(|_| "native window unavailable")?.0 as *mut std::ffi::c_void;
    Ok(WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        parent,
        &Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        },
    ))
}
pub fn layout(
    app: &tauri::AppHandle,
    browser: &Browser,
    _id: u32,
    bounds: Bounds,
    active: bool,
    locked: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let host = browser.host().ok_or("page closed")?;
    let handle = host.window_handle() as usize;
    let visible = active && bounds.visible && bounds.width > 0.0 && bounds.height > 0.0;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSView, NSWindow};
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        // Tauri's renderer rect is the CSS coordinate reference, including titlebar offsets.
        unsafe {
            use objc2::{runtime::NSObjectProtocol, ClassType};
            let native = &*(window
                .ns_window()
                .map_err(|_| "native window unavailable")?
                as *const NSWindow);
            if let Some(parent) = native.contentView() {
                // Stay in the owned CEF dispatcher. with_webview constructs
                // separately retained raw WK/manager/window handles on macOS.
                let children = parent.subviews();
                let renderer_parent = children.firstObject().ok_or("renderer unavailable")?;
                super::container::trace("layout-parent", &renderer_parent);
                let renderer_children = renderer_parent.subviews();
                let renderer = renderer_children
                    .iter()
                    .find(|view| view.isKindOfClass(objc2_web_kit::WKWebView::class()))
                    .ok_or("renderer unavailable")?;
                let view = &*(handle as *const NSView);
                if bounds.width <= 0.0 || bounds.height <= 0.0 {
                    super::input::hide(_id);
                    return Ok(());
                }
                let size = renderer.bounds().size;
                #[cfg(feature = "cef-acceptance")]
                eprintln!(
                    "[cef-viewport-native] visible={visible} renderer={}x{} slot={}x{}",
                    size.width, size.height, bounds.width, bounds.height
                );
                let x = bounds.x.min(size.width);
                let y = bounds.y.min(size.height);
                let width = bounds.width.min((size.width - x).max(0.0));
                let height = bounds.height.min((size.height - y).max(0.0));
                let local = NSRect::new(
                    NSPoint::new(
                        x,
                        if renderer.isFlipped() {
                            y
                        } else {
                            size.height - y - height
                        },
                    ),
                    NSSize::new(width, height),
                );
                let frame = renderer.convertRect_toView(local, Some(&parent));
                view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
                // Only the owned container is detached; Chromium observes its
                // window transition and restores compositor visibility on reattach.
                view.setHidden(false);
                super::input::layout(_id, &parent, frame, visible);
            }
        }
    }
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowPos(
                h: *mut std::ffi::c_void,
                after: *mut std::ffi::c_void,
                x: i32,
                y: i32,
                w: i32,
                hgt: i32,
                flags: u32,
            ) -> i32;
            fn ShowWindow(h: *mut std::ffi::c_void, cmd: i32) -> i32;
            fn EnableWindow(h: *mut std::ffi::c_void, enabled: i32) -> i32;
        }
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            ShowWindow(handle as _, 0);
            EnableWindow(handle as _, (!locked) as i32);
            return Ok(());
        }
        let scale = window.scale_factor().map_err(|_| "CEF DPI unavailable")?;
        SetWindowPos(
            handle as *mut std::ffi::c_void,
            std::ptr::null_mut(),
            (bounds.x * scale).round() as i32,
            (bounds.y * scale).round() as i32,
            (bounds.width * scale).round() as i32,
            (bounds.height * scale).round() as i32,
            0x0014,
        );
        ShowWindow(handle as *mut std::ffi::c_void, if visible { 5 } else { 0 });
        EnableWindow(handle as *mut std::ffi::c_void, (!locked) as i32);
    }
    if locked || !visible {
        host.set_focus(0);
    }
    Ok(())
}

/// Complete DoClose by tearing down the CEF child, never its top-level window.
pub fn destroy(id: u32) {
    super::registry::mark_closing(id);
    super::pump::defer(move || {
        // Resolve at execution time: a page may have closed before this task ran.
        let Some(handle) = super::registry::native_handle(id) else {
            return;
        };
        #[cfg(target_os = "macos")]
        unsafe {
            super::input::hide(id);
            let view = &*(handle as *const objc2_app_kit::NSView);
            view.removeFromSuperview();
        }
        #[cfg(target_os = "windows")]
        unsafe {
            #[link(name = "user32")]
            extern "system" {
                fn DestroyWindow(window: *mut std::ffi::c_void) -> i32;
            }
            DestroyWindow(handle as *mut std::ffi::c_void);
        }
    });
}
