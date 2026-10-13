use objc2_foundation::NSObjectNSKeyValueObserverRegistration;
mod browsing;
mod contact;
mod passwords;
mod popup;
mod viewport;
use objc2::Message;
pub use passwords::manage as manage_password;
mod credentials;
pub(super) mod downloads;
mod load_state;
mod navigation;
mod registry;
mod storage;
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
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

use tauri::{AppHandle, Manager};

pub fn supported_version() -> bool {
    // Media permission denial and download policy hooks require modern WebKit.
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 12
}

pub fn attach(app: &AppHandle) -> Result<(), String> {
    attach_view(app, None, true).map(|_| ())
}

pub(super) fn attach_view(
    app: &AppHandle,
    configuration: Option<&WKWebViewConfiguration>,
    navigate: bool,
) -> Result<objc2::rc::Retained<WKWebView>, String> {
    if REGISTRY.with(|r| r.borrow().clearing) {
        return Err("浏览数据正在清理".into());
    }
    let id = state::snapshot(app)
        .active_tab_id
        .ok_or("no active browser tab")?;
    REGISTRY.with(|registry| registry.borrow_mut().active = Some(id));
    registry::refresh();
    if let Some(view) = REGISTRY.with(|registry| {
        registry
            .borrow()
            .guests
            .get(&id)
            .map(|guest| guest.view.clone())
    }) {
        return Ok(view);
    }
    let marker = MainThreadMarker::new().ok_or("browser requires main thread")?;
    let window = app
        .get_webview_window("main")
        .ok_or("browser window unavailable")?;
    let pointer = window
        .ns_window()
        .map_err(|_| "native window unavailable")?;
    // SAFETY: Tauri owns this NSWindow; access only on its main thread, no ownership transfer.
    let view = unsafe {
        let native = &*(pointer as *const NSWindow);
        let parent = native
            .contentView()
            .ok_or("native content view unavailable")?;
        let config = configuration
            .map(|config| config.retain())
            .unwrap_or_else(|| WKWebViewConfiguration::new(marker));
        let store = storage::store(app, marker)?;
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
        for key in ["title", "estimatedProgress"] {
            view.addObserver_forKeyPath_options_context(
                &navigation,
                &NSString::from_str(key),
                objc2_foundation::NSKeyValueObservingOptions::New,
                std::ptr::null_mut(),
            );
        }
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
        view.unregisterDraggedTypes();
        view.setHidden(true);
        parent.addSubview(&view);
        REGISTRY.with(|registry| {
            registry.borrow_mut().guests.insert(
                id,
                Guest {
                    view: view.clone(),
                    _navigation: navigation,
                    _ui: ui,
                    ready: false,
                    initial_position_pending: true,
                },
            );
        });
        view
    };
    registry::refresh();
    if navigate {
        if let Some(url) = state::snapshot(app).url {
            control(app, &Action::Navigate { url })?;
        }
    }
    policy::audit("attach", None, "isolated-no-ipc");
    Ok(view)
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
        return viewport::layout(app, *x, *y, *width, *height, *visible);
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
                REGISTRY.with(|registry| {
                    if let Some(guest) = registry.borrow_mut().guests.get_mut(&id) {
                        guest.initial_position_pending = true;
                    }
                });
                state::update_tab(app, id, |state| {
                    state.url = Some(url.to_string());
                    state.status = "loading".into();
                    state.progress = 0.0;
                    state.notice = None;
                });
                let native_url = NSURL::URLWithString(&NSString::from_str(url.as_str()))
                    .ok_or("invalid native URL")?;
                REGISTRY.with(|registry| {
                    if let Some(guest) = registry.borrow().guests.get(&id) {
                        guest._navigation.begin_origin(url.as_str());
                    }
                });
                let navigation = view.loadRequest(&NSURLRequest::requestWithURL(&native_url));
                REGISTRY.with(|registry| {
                    if let Some(guest) = registry.borrow().guests.get(&id) {
                        guest._navigation.track(navigation.as_deref());
                    }
                });
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
                load_state::publish(app, id, &view, "ready", Some("已停止加载".into()), true);
            }
            Action::Fillcontact { contact } => contact::fill(app, &view, contact)?,
            Action::Find { text, backwards } => browsing::find(&view, text, *backwards)?,
            Action::Zoom { factor } => view.setPageZoom(*factor),
            Action::Print => browsing::print(&view, app)?,
            // Navigation delegates own load/error state; status must not erase a failure.
            Action::Status => {}
            _ => {}
        }
    }
    Ok(())
}

pub fn persistent_available() -> bool {
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 14
}
pub fn clear_data(
    app: &AppHandle,
    website_data: bool,
    cache: bool,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) {
    storage::clear(app, website_data, cache, done)
}

pub fn clearing() -> bool {
    REGISTRY.with(|r| r.borrow().clearing)
}
pub fn media_available() -> bool {
    let bundle = objc2_foundation::NSBundle::mainBundle();
    ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]
        .iter()
        .all(|key| {
            bundle
                .objectForInfoDictionaryKey(&NSString::from_str(key))
                .and_then(|v| v.downcast::<NSString>().ok())
                .is_some_and(|v| !v.is_empty())
        })
}
