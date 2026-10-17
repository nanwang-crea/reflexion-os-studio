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
        window
            .with_webview(move |platform| unsafe {
                let renderer = &*(platform.inner() as *const NSView);
                let native = &*(platform.ns_window() as *const NSWindow);
                if let Some(parent) = native.contentView() {
                    let view = &*(handle as *const NSView);
                    if bounds.width <= 0.0 || bounds.height <= 0.0 {
                        if let Some(container) = view.superview() {
                            container.setHidden(true);
                        }
                        view.setHidden(true);
                        return;
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
                    if let Some(container) = view.superview() {
                        container.setFrame(frame);
                        container.setHidden(!visible);
                    }
                    view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
                    view.setHidden(!visible);
                }
            })
            .map_err(|_| "CEF viewport unavailable")?;
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

#[cfg(target_os = "windows")]
pub fn destroy(browser: &Browser) {
    #[link(name = "user32")]
    extern "system" {
        fn DestroyWindow(window: *mut std::ffi::c_void) -> i32;
    }
    if let Some(host) = browser.host() {
        unsafe {
            DestroyWindow(host.window_handle() as *mut std::ffi::c_void);
        }
    }
}
