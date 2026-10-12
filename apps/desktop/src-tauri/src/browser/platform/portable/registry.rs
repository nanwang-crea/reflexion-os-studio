use super::{Bounds, Engine};
use crate::browser::state::{self, Action};
use std::{cell::RefCell, rc::Rc};
use tauri::AppHandle;

use super::super::guest_registry::{self, Registry};

thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

pub fn attach(app: &AppHandle) -> Result<(), String> {
    if !super::super::available() {
        return Err(super::super::unavailable_notice().into());
    }
    let id = state::snapshot(app).active_tab_id.ok_or("没有活动标签")?;
    select(app)?;
    let exists = REGISTRY.with(|r| r.borrow().guests.contains_key(&id));
    if !exists {
        let creating = REGISTRY.with(|r| r.borrow_mut().creating.insert(id));
        if !creating {
            return Err("网页视图正在创建".into());
        }
        // Engine creation can reenter callbacks; never hold a registry borrow here.
        #[cfg(target_os = "windows")]
        let result = super::super::windows::create(app, id);
        #[cfg(target_os = "linux")]
        let result = super::super::linux::create(app, id);
        REGISTRY.with(|r| r.borrow_mut().creating.remove(&id));
        adopt(app, id, result?)?;
    }
    if !exists {
        let snapshot = state::snapshot(app);
        let tab = snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == id)
            .ok_or("标签已关闭")?;
        if let Some(url) = &tab.url {
            control_tab(app, id, &Action::Navigate { url: url.clone() })?;
        }
    }
    Ok(())
}

pub(super) fn select(app: &AppHandle) -> Result<(), String> {
    let active = state::snapshot(app).active_tab_id;
    REGISTRY.with(|r| r.borrow_mut().select(active));
    refresh()
}

fn refresh() -> Result<(), String> {
    REGISTRY.with(guest_registry::refresh)
}

pub(super) fn adopt(app: &AppHandle, id: u32, engine: Box<dyn Engine>) -> Result<(), String> {
    let snapshot = state::snapshot(app);
    if super::clearing() || !snapshot.tabs.iter().any(|tab| tab.id == id) {
        engine.stop();
        return Err("浏览会话或标签已关闭".into());
    }
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        r.insert(id, Rc::from(engine));
        r.select(snapshot.active_tab_id);
    });
    refresh()?;
    if !state::snapshot(app).tabs.iter().any(|tab| tab.id == id) {
        return Err("标签已关闭".into());
    }
    Ok(())
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
            r.layout(
                Bounds {
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                },
                *visible && *width > 0.0 && *height > 0.0,
            );
        });
        return refresh();
    }
    let id = state::snapshot(app).active_tab_id.ok_or("没有活动标签")?;
    control_tab(app, id, action)
}

fn control_tab(app: &AppHandle, id: u32, action: &Action) -> Result<(), String> {
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
    if let Some(engine) = REGISTRY.with(|r| r.borrow_mut().remove(id)) {
        engine.stop();
    }
}

pub fn dispose() {
    super::downloads::dispose();
    let guests = REGISTRY.with(|r| r.borrow_mut().clear());
    for engine in guests.into_values() {
        engine.stop();
    }
    #[cfg(target_os = "windows")]
    super::super::windows::dispose();
    #[cfg(target_os = "linux")]
    super::super::linux::dispose();
}
