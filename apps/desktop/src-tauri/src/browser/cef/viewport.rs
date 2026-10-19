use super::registry::{Bounds, Policy};
use cef::*;
use std::sync::Arc;
#[cfg(target_os = "windows")]
use tauri::Manager;

pub fn window_info(
    app: &tauri::AppHandle,
    _id: u32,
    _policy: Arc<Policy>,
) -> Result<WindowInfo, String> {
    #[cfg(target_os = "windows")]
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    #[cfg(target_os = "macos")]
    let parent = {
        super::container::ensure(app)?;
        let embedding = super::container::current(app)?;
        super::input::create(_id, &embedding.root, _policy)?
    };
    #[cfg(target_os = "windows")]
    let parent = window.hwnd().map_err(|_| "native window unavailable")?.0;
    Ok(WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        super::handles::from_raw(parent),
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
    #[cfg(target_os = "windows")]
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let host = browser.host().ok_or("page closed")?;
    let handle = super::handles::address(host.window_handle());
    let visible = active && bounds.visible && bounds.width > 0.0 && bounds.height > 0.0;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSView;
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        // Tauri's renderer rect is the CSS coordinate reference, including titlebar offsets.
        unsafe {
            let embedding = super::container::current(app)?;
            let parent = &embedding.root;
            let renderer = &embedding.renderer;
            {
                // GetWindowHandle is borrowed. Keep the child alive across AppKit
                // layout and window-transition callbacks, then release this scope.
                let view = objc2::rc::Retained::retain(handle as *mut NSView)
                    .ok_or("native browser view unavailable")?;
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
                let frame = renderer.convertRect_toView(local, Some(parent));
                // Resize the parent first: Chromium's child autoresizes with it.
                // Setting the child first would apply the parent's size delta
                // twice, moving the page edges and scrollbars outside the slot.
                // Only the owned container is detached; Chromium observes its
                // window transition and restores compositor visibility on reattach.
                super::input::layout(_id, parent, frame, visible);
                view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
                view.setHidden(false);
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
            let Some(view) = objc2::rc::Retained::retain(handle as *mut objc2_app_kit::NSView)
            else {
                return;
            };
            super::input::hide(id);
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
