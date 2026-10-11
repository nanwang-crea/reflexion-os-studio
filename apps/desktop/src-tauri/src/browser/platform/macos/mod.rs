use objc2_foundation::NSObjectNSKeyValueObserverRegistration;
mod credentials;
mod navigation;
mod registry;
pub use credentials::{fill, install_cookies};
pub use registry::{close_tab, dispose};
use registry::{Guest, REGISTRY};
mod ui_delegate;

use crate::browser::{
    policy,
    state::{self, Action},
};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::NSWindow;
use objc2_foundation::{
    MainThreadMarker, NSPoint, NSProcessInfo, NSRect, NSSize, NSString, NSURLRequest, NSURL,
};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};

use tauri::{AppHandle, Manager};

pub fn supported_version() -> bool {
    // Media permission denial and download policy hooks require modern WebKit.
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 12
}

pub fn attach(app: &AppHandle) -> Result<(), String> {
    let id = state::snapshot(app)
        .active_tab_id
        .ok_or("no active browser tab")?;
    REGISTRY.with(|registry| registry.borrow_mut().active = Some(id));
    registry::refresh();
    if REGISTRY.with(|registry| registry.borrow().guests.contains_key(&id)) {
        return Ok(());
    }
    let marker = MainThreadMarker::new().ok_or("browser requires main thread")?;
    let window = app
        .get_webview_window("main")
        .ok_or("browser window unavailable")?;
    let pointer = window
        .ns_window()
        .map_err(|_| "native window unavailable")?;
    // SAFETY: Tauri owns this NSWindow; access only on its main thread, no ownership transfer.
    unsafe {
        let native = &*(pointer as *const NSWindow);
        let parent = native
            .contentView()
            .ok_or("native content view unavailable")?;
        let config = WKWebViewConfiguration::new(marker);
        let store = REGISTRY.with(|registry| {
            let mut registry = registry.borrow_mut();
            registry
                .store
                .get_or_insert_with(|| WKWebsiteDataStore::nonPersistentDataStore(marker))
                .clone()
        });
        if store.isPersistent() {
            return Err("non-persistent browser storage unavailable".into());
        }
        config.setWebsiteDataStore(&store);
        config
            .preferences()
            .setJavaScriptCanOpenWindowsAutomatically(false);
        // Fresh WKWebView: no IPC handlers, user scripts, custom schemes, or app data store.
        let view = WKWebView::initWithFrame_configuration(
            marker.alloc(),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
            &config,
        );
        let navigation = navigation::NavigationDelegate::new(marker, app.clone(), id);
        let ui = ui_delegate::UiDelegate::new(marker, app.clone(), id);
        view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation)));
        view.addObserver_forKeyPath_options_context(
            &navigation,
            &NSString::from_str("title"),
            objc2_foundation::NSKeyValueObservingOptions::New,
            std::ptr::null_mut(),
        );
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
        view.unregisterDraggedTypes();
        view.setHidden(true);
        parent.addSubview(&view);
        REGISTRY.with(|registry| {
            registry.borrow_mut().guests.insert(
                id,
                Guest {
                    view,
                    _navigation: navigation,
                    _ui: ui,
                    ready: false,
                },
            );
        });
    }
    if let Some(url) = state::snapshot(app).url {
        control(app, &Action::Navigate { url })?;
    }
    policy::audit("attach", None, "nonpersistent-no-ipc");
    Ok(())
}

/// CSS pixels are logical points; clamp native content to the current client area.
fn layout(
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
    let pointer = window
        .ns_window()
        .map_err(|_| "native window unavailable")?;
    // Full-size content views include the titlebar; CSS viewport starts below it.
    let bounds = unsafe { (&*(pointer as *const NSWindow)).contentLayoutRect() };
    let client_width = bounds.size.width;
    let client_height = bounds.size.height;
    let width = width.min((client_width - x).max(0.0));
    let height = height.min((client_height - y).max(0.0));
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.visible = visible && width > 0.0 && height > 0.0;
        registry.frame = Some(NSRect::new(
            NSPoint::new(
                bounds.origin.x + x,
                bounds.origin.y + (client_height - y - height).max(0.0),
            ),
            NSSize::new(width, height),
        ));
    });
    registry::refresh();
    Ok(())
}

pub(super) fn reveal(id: u32) {
    registry::mark_ready(id, true);
}
pub(super) fn hide(id: u32) {
    registry::mark_ready(id, false);
}

pub fn control(app: &AppHandle, action: &Action) -> Result<(), String> {
    if let Action::Layout {
        x,
        y,
        width,
        height,
        visible,
    } = action
    {
        return layout(app, *x, *y, *width, *height, *visible);
    }
    // Do not borrow the thread-local Guest while invoking WebKit: native callbacks may reenter.
    let id = state::snapshot(app).active_tab_id;
    let view = REGISTRY.with(|registry| {
        id.and_then(|id| {
            registry
                .borrow()
                .guests
                .get(&id)
                .map(|guest| guest.view.clone())
        })
    });
    let (Some(view), Some(id)) = (view, id) else {
        if matches!(action, Action::Status) {
            return Ok(());
        }
        return Err("browser not attached".into());
    };
    unsafe {
        match action {
            Action::Navigate { url } => {
                let url = policy::guest_url(url, crate::browser::policy::dev_url(app))?;
                state::update_tab(app, id, |state| {
                    state.url = Some(url.to_string());
                    state.status = "loading".into();
                    state.notice = None;
                });
                let native_url = NSURL::URLWithString(&NSString::from_str(url.as_str()))
                    .ok_or("invalid native URL")?;
                view.loadRequest(&NSURLRequest::requestWithURL(&native_url));
                policy::audit("navigate", Some(url.as_str()), "requested");
            }
            Action::Back => {
                view.goBack();
            }
            Action::Forward => {
                view.goForward();
            }
            Action::Reload => {
                view.reload();
            }
            Action::Stop => {
                view.stopLoading();
                reveal(id);
                navigation::publish(app, id, &view, "ready", Some("已停止加载".into()));
            }
            Action::Status => navigation::publish(
                app,
                id,
                &view,
                if view.isLoading() { "loading" } else { "ready" },
                None,
            ),
            _ => {}
        }
    }
    Ok(())
}
