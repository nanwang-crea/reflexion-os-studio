use crate::browser::state::{self, Action};
use cef::*;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub struct Policy {
    pub origin: Option<String>,
    pub dev_url: Option<url::Url>,
    pub locked: AtomicBool,
    pub network_ready: AtomicBool,
}
pub struct Lease {
    pub id: String,
    pub origin: String,
}
pub struct Guest {
    pub browser: Browser,
    pub policy: Arc<Policy>,
    pub lease: Option<String>,
    pub closing: bool,
}
#[derive(Clone, Copy, Default)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}
#[derive(Default)]
struct Registry {
    guests: HashMap<u32, Guest>,
    bounds: Bounds,
    user_context: Option<RequestContext>,
}
thread_local! { static GUESTS:RefCell<Registry>=RefCell::new(Registry::default()); }

pub fn attach(app: &tauri::AppHandle, lease: Option<Lease>) -> Result<(), String> {
    if !super::accepting() {
        return Err("CEF browser unavailable".into());
    }
    let snapshot = state::snapshot(app);
    let id = snapshot.active_tab_id.ok_or("no active browser tab")?;
    if GUESTS.with(|r| r.borrow().guests.contains_key(&id)) {
        return refresh(app);
    }
    let policy = Arc::new(Policy {
        origin: lease.as_ref().map(|lease| lease.origin.clone()),
        locked: AtomicBool::new(lease.is_some()),
        network_ready: AtomicBool::new(lease.is_none()),
        dev_url: crate::browser::policy::dev_url(app).cloned(),
    });
    let mut context = if lease.is_some() {
        super::contexts::agent(policy.clone())?
    } else {
        super::contexts::user(app)?
    };
    let info = super::viewport::window_info(app, id, policy.clone())?;
    let mut client = super::client::GuestClient::new(app.clone(), id, policy.clone());
    let url = lease
        .as_ref()
        .map(|lease| format!("about:blank#{}", lease.id))
        .or(snapshot.url)
        .unwrap_or_else(|| "about:blank".into());
    let browser = browser_host_create_browser_sync(
        Some(&info),
        Some(&mut client),
        Some(&CefString::from(url.as_str())),
        Some(&BrowserSettings::default()),
        None,
        Some(&mut context),
    )
    .ok_or_else(|| {
        super::input::remove(id);
        "CEF page unavailable"
    })?;
    GUESTS.with(|r| {
        r.borrow_mut().guests.insert(
            id,
            Guest {
                browser,
                policy,
                lease: lease.map(|lease| lease.id),
                closing: false,
            },
        );
    });
    if !super::accepting() {
        close(id);
    }
    refresh(app)
}
pub fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let active = state::snapshot(app).active_tab_id;
    let (bounds, guests) = GUESTS.with(|r| {
        let r = r.borrow();
        (
            r.bounds,
            r.guests
                .iter()
                .filter(|(_, g)| !g.closing)
                .map(|(id, g)| (*id, g.browser.clone(), g.policy.clone()))
                .collect::<Vec<_>>(),
        )
    });
    for (id, browser, policy) in guests {
        #[cfg(feature = "cef-acceptance")]
        eprintln!(
            "[cef-viewport] id={id} active={} visible={} bounds={}x{}",
            active == Some(id),
            bounds.visible,
            bounds.width,
            bounds.height
        );
        super::viewport::layout(
            app,
            &browser,
            id,
            bounds,
            active == Some(id),
            policy.locked.load(Ordering::Acquire),
        )?;
    }
    Ok(())
}
pub fn control(app: &tauri::AppHandle, action: &Action) -> Result<(), String> {
    if matches!(action, Action::Status) {
        return Ok(());
    }
    if let Action::Layout {
        x,
        y,
        width,
        height,
        visible,
    } = action
    {
        GUESTS.with(|r| {
            r.borrow_mut().bounds = Bounds {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
                visible: *visible,
            }
        });
        return refresh(app);
    }
    let id = state::snapshot(app)
        .active_tab_id
        .ok_or("no active browser tab")?;
    let (browser, policy) = GUESTS
        .with(|r| {
            r.borrow()
                .guests
                .get(&id)
                .map(|g| (g.browser.clone(), g.policy.clone()))
        })
        .ok_or("CEF page unavailable")?;
    if policy.origin.is_some()
        && policy.locked.load(Ordering::Acquire)
        && !matches!(action, Action::Status | Action::Takeover | Action::Resume)
    {
        return Err("Agent 标签的导航和页面工具由任务管理，请新建普通标签浏览".into());
    }
    match action {
        Action::Navigate { url } => {
            let url = crate::browser::policy::guest_url(url, crate::browser::policy::dev_url(app))?;
            state::update_tab(app, id, |tab| {
                tab.url = Some(url.to_string());
                tab.status = "loading".into();
                tab.progress = 0.0;
                tab.notice = None;
            });
            browser
                .main_frame()
                .ok_or("page closed")?
                .load_url(Some(&CefString::from(url.as_str())));
        }
        Action::Back => browser.go_back(),
        Action::Forward => browser.go_forward(),
        Action::Reload => browser.reload(),
        Action::Stop => browser.stop_load(),
        Action::Zoom { factor } => {
            browser
                .host()
                .ok_or("page closed")?
                .set_zoom_level(factor.ln() / 1.2f64.ln());
        }
        Action::Find { text, backwards } => {
            browser.host().ok_or("page closed")?.find(
                Some(&CefString::from(text.as_str())),
                (!backwards) as i32,
                0,
                0,
            );
        }
        Action::Print => browser.host().ok_or("page closed")?.print(),
        Action::Takeover | Action::Resume => {
            if policy.origin.is_none() {
                return Err("当前标签未由 Agent 控制".into());
            }
            let locked = matches!(action, Action::Resume);
            policy.locked.store(locked, Ordering::Release);
            if let Some(lease) =
                GUESTS.with(|r| r.borrow().guests.get(&id).and_then(|g| g.lease.clone()))
            {
                crate::host::browser::control_changed(app, &lease, !locked);
            }
            state::update_tab(app, id, |tab| {
                tab.control = if locked { "agent" } else { "paused" }.into()
            });
            refresh(app)?;
        }
        Action::Status => {}
        _ => return Err("此操作尚未由 CEF 适配器提供".into()),
    }
    Ok(())
}
pub fn lease_tab(lease: &str) -> Option<(u32, bool, bool)> {
    GUESTS.with(|r| {
        r.borrow()
            .guests
            .iter()
            .find(|(_, g)| !g.closing && g.lease.as_deref() == Some(lease))
            .map(|(id, g)| {
                (
                    *id,
                    g.policy.locked.load(Ordering::Acquire),
                    g.policy.network_ready.load(Ordering::Acquire),
                )
            })
    })
}
pub fn native_handle(id: u32) -> Option<usize> {
    GUESTS.with(|r| {
        r.borrow()
            .guests
            .get(&id)?
            .browser
            .host()
            .map(|host| super::handles::address(host.window_handle()))
    })
}
pub fn mark_closing(id: u32) {
    GUESTS.with(|r| {
        if let Some(guest) = r.borrow_mut().guests.get_mut(&id) {
            guest.closing = true;
        }
    });
}
pub fn popup_allowed(id: u32) -> bool {
    GUESTS.with(|r| {
        r.borrow()
            .guests
            .get(&id)
            .is_some_and(|g| !g.closing && g.lease.is_none())
    })
}
pub fn close(id: u32) {
    let browser = GUESTS.with(|r| {
        let mut registry = r.borrow_mut();
        let guest = registry.guests.get_mut(&id)?;
        if guest.closing {
            return None;
        }
        guest.closing = true;
        Some(guest.browser.clone())
    });
    if let Some(host) = browser.and_then(|browser| browser.host()) {
        host.close_browser(1);
    }
}
pub fn reset_user(app: &tauri::AppHandle) {
    let ids = GUESTS.with(|r| {
        r.borrow()
            .guests
            .iter()
            .filter(|(_, g)| g.lease.is_none())
            .map(|(id, _)| *id)
            .collect::<Vec<_>>()
    });
    for id in ids {
        close(id);
        state::update(app, |state| {
            let _ = state.close_tab(id);
        });
    }
    GUESTS.with(|r| r.borrow_mut().user_context = None);
}
pub fn user_context() -> Option<RequestContext> {
    GUESTS.with(|r| r.borrow().user_context.clone())
}
pub fn active_user(app: &tauri::AppHandle) -> Result<Browser, String> {
    let id = state::snapshot(app).active_tab_id.ok_or("没有活动网页")?;
    GUESTS
        .with(|r| {
            r.borrow()
                .guests
                .get(&id)
                .filter(|g| !g.closing && g.lease.is_none())
                .map(|g| g.browser.clone())
        })
        .ok_or_else(|| "此操作仅适用于用户浏览标签，不能访问 Agent 标签".into())
}
pub fn close_agents(app: &tauri::AppHandle) {
    let ids = GUESTS.with(|r| {
        r.borrow()
            .guests
            .iter()
            .filter(|(_, g)| g.lease.is_some())
            .map(|(id, _)| *id)
            .collect::<Vec<_>>()
    });
    for id in ids {
        close(id);
        state::update(app, |state| {
            let _ = state.close_tab(id);
        });
    }
}
pub fn dispose() {
    GUESTS.with(|r| r.borrow_mut().user_context = None);
    let ids = GUESTS.with(|r| r.borrow().guests.keys().copied().collect::<Vec<_>>());
    for id in ids {
        close(id);
    }
}

pub fn set_user_context(context: RequestContext) {
    GUESTS.with(|r| r.borrow_mut().user_context = Some(context));
}

pub fn closed(app: &tauri::AppHandle, id: u32) {
    GUESTS.with(|r| r.borrow_mut().guests.remove(&id));
    if state::snapshot(app).tabs.iter().any(|tab| tab.id == id) {
        state::update(app, |state| {
            let _ = state.close_tab(id);
        });
    }
}
