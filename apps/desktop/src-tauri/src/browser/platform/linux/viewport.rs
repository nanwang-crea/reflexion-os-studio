use gtk::prelude::*;
use std::cell::RefCell;
thread_local! { static PARENT: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) }; }

// Use a GTK overlay rather than an X11 window handle; this also supports Wayland.
pub(super) fn parent(window: &tauri::WebviewWindow) -> Result<gtk::Fixed, String> {
    if let Some(parent) = PARENT.with(|p| p.borrow().clone()) {
        return Ok(parent);
    }
    let vbox = window.default_vbox().map_err(|_| "GTK 主窗口不可用")?;
    let children = vbox.children();
    let (position, renderer) = children
        .iter()
        .enumerate()
        .find(|(_, widget)| contains_renderer(widget))
        .ok_or("GTK Renderer 容器不可用")?;
    let overlay = gtk::Overlay::new();
    overlay.set_hexpand(true);
    overlay.set_vexpand(true);
    let fixed = gtk::Fixed::new();
    fixed.set_hexpand(true);
    fixed.set_vexpand(true);
    vbox.remove(renderer);
    overlay.add(renderer);
    overlay.add_overlay(&fixed);
    vbox.pack_start(&overlay, true, true, 0);
    vbox.reorder_child(&overlay, position as i32);
    overlay.show_all();
    PARENT.with(|p| *p.borrow_mut() = Some(fixed.clone()));
    Ok(fixed)
}

fn contains_renderer(widget: &gtk::Widget) -> bool {
    widget.is::<webkit2gtk::WebView>()
        || widget
            .downcast_ref::<gtk::Container>()
            .is_some_and(|container| container.children().iter().any(contains_renderer))
}
