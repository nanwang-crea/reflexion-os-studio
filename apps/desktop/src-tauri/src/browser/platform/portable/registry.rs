use super::{Bounds, Engine};
use crate::browser::state::{self, Action};
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use tauri::AppHandle;

#[derive(Default)]
struct Registry {
    guests: HashMap<u32, Rc<dyn Engine>>,
    active: Option<u32>,
    bounds: Bounds,
    visible: bool,
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

pub fn attach(app: &AppHandle) -> Result<(), String> {
    if !super::super::available() {
        return Err(super::super::unavailable_notice().into());
    }
    let id = state::snapshot(app).active_tab_id.ok_or("没有活动标签")?;
    let exists = REGISTRY.with(|r| r.borrow().guests.contains_key(&id));
    if !exists {
        // Engine creation can reenter callbacks; never hold a registry borrow here.
        #[cfg(target_os = "windows")]
        let engine = super::super::windows::create(app, id)?;
        #[cfg(target_os = "linux")]
        let engine = super::super::linux::create(app, id)?;
        REGISTRY.with(|r| r.borrow_mut().guests.insert(id, Rc::from(engine)));
    }
    REGISTRY.with(|r| r.borrow_mut().active = Some(id));
    refresh()?;
    if !exists {
        if let Some(url) = state::snapshot(app).url {
            control(app, &Action::Navigate { url })?;
        }
    }
    Ok(())
}

fn refresh() -> Result<(), String> {
    let (guests, bounds, active, visible) = REGISTRY.with(|r| {
        let r = r.borrow();
        (
            r.guests
                .iter()
                .map(|(id, engine)| (*id, engine.clone()))
                .collect::<Vec<_>>(),
            r.bounds,
            r.active,
            r.visible,
        )
    });
    // Native layout may emit callbacks. Release the registry borrow first.
    for (id, engine) in guests {
        engine.layout(bounds, visible && active == Some(id))?;
    }
    Ok(())
}

pub(super) fn adopt(app: &AppHandle, id: u32, engine: Box<dyn Engine>) -> Result<(), String> {
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        r.guests.insert(id, Rc::from(engine));
        r.active = state::snapshot(app).active_tab_id;
    });
    refresh()
}

pub fn control(app: &AppHandle, action: &Action) -> Result<(), String> {
    if !super::super::available() {
        return Err(super::super::unavailable_notice().into());
    }
    if let Action::Layout {
        x,
        y,
        width,
        height,
        visible,
    } = action
    {
        REGISTRY.with(|r| {
            let mut r = r.borrow_mut();
            r.bounds = Bounds {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            };
            r.visible = *visible && *width > 0.0 && *height > 0.0;
        });
        return refresh();
    }
    let id = state::snapshot(app).active_tab_id.ok_or("没有活动标签")?;
    if let Action::Navigate { url } = action {
        crate::browser::policy::guest_url(url, crate::browser::policy::dev_url(app))?;
    }
    // Keep ownership during native modal calls, without holding a RefCell borrow.
    let engine = REGISTRY
        .with(|r| r.borrow().guests.get(&id).cloned())
        .ok_or("网页视图尚未创建")?;
    engine.control(action)
}

pub fn close_tab(id: u32) {
    if let Some(engine) = REGISTRY.with(|r| r.borrow_mut().guests.remove(&id)) {
        engine.stop();
    }
}

pub fn dispose() {
    super::downloads::dispose();
    let guests = REGISTRY.with(|r| std::mem::take(&mut *r.borrow_mut()));
    for engine in guests.guests.into_values() {
        engine.stop();
    }
    #[cfg(target_os = "windows")]
    super::super::windows::dispose();
    #[cfg(target_os = "linux")]
    super::super::linux::dispose();
}
