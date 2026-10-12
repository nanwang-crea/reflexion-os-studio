use super::registry::{self, REGISTRY};
use objc2_app_kit::NSWindow;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Manager};

// CSS uses a top-left origin. NSView may use either orientation.
fn local_frame(bounds: NSRect, flipped: bool, x: f64, y: f64, width: f64, height: f64) -> NSRect {
    let x = x.min(bounds.size.width);
    let y = y.min(bounds.size.height);
    let width = width.min((bounds.size.width - x).max(0.0));
    let height = height.min((bounds.size.height - y).max(0.0));
    NSRect::new(
        NSPoint::new(
            bounds.origin.x + x,
            bounds.origin.y
                + if flipped {
                    y
                } else {
                    bounds.size.height - y - height
                },
        ),
        NSSize::new(width, height),
    )
}

pub(super) fn layout(
    app: &AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    if [x, y, width, height]
        .iter()
        .any(|n| !n.is_finite() || *n < 0.0 || *n > 100000.0)
    {
        return Err("invalid browser bounds".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    window
        .with_webview(move |platform| unsafe {
            // Measure relative to the actual app renderer, then convert into the guest's parent.
            // Window contentLayoutRect alone can differ from the renderer's frame and orientation.
            let renderer = &*(platform.inner() as *const WKWebView);
            let native = &*(platform.ns_window() as *const NSWindow);
            let Some(parent) = native.contentView() else {
                return;
            };
            let local = local_frame(renderer.bounds(), renderer.isFlipped(), x, y, width, height);
            let frame = renderer.convertRect_toView(local, Some(&parent));
            REGISTRY.with(|registry| {
                let mut registry = registry.borrow_mut();
                registry.visible = visible && frame.size.width > 0.0 && frame.size.height > 0.0;
                registry.frame = Some(frame);
            });
            registry::refresh();
        })
        .map_err(|_| "native viewport unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_slot_stays_below_toolbar_in_both_coordinate_systems() {
        let bounds = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1200.0, 800.0));
        let flipped = local_frame(bounds, true, 200.0, 170.0, 600.0, 630.0);
        let ordinary = local_frame(bounds, false, 200.0, 170.0, 600.0, 630.0);
        assert_eq!(flipped.origin.y, 170.0);
        assert_eq!(ordinary.origin.y, 0.0);
        assert_eq!(ordinary.origin.y + ordinary.size.height, 630.0);
        assert_eq!(flipped.size, ordinary.size);
    }
    #[test]
    fn slot_clamps_to_renderer_and_respects_nonzero_bounds_origin() {
        let bounds = NSRect::new(NSPoint::new(3.0, 5.0), NSSize::new(500.0, 400.0));
        let frame = local_frame(bounds, true, 450.0, 350.0, 300.0, 200.0);
        assert_eq!(frame.origin, NSPoint::new(453.0, 355.0));
        assert_eq!(frame.size, NSSize::new(50.0, 50.0));
        assert_eq!(
            local_frame(bounds, false, 600.0, 500.0, 10.0, 10.0).size,
            NSSize::new(0.0, 0.0)
        );
    }
}
