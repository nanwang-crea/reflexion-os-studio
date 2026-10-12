use super::load_state::{failed, publish};
use crate::browser::{policy, state};
use block2::Block;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::NSObject, DefinedClass, MainThreadOnly,
};
use objc2_foundation::{MainThreadMarker, NSError, NSHTTPURLResponse, NSObjectProtocol, NSString};
use objc2_web_kit::{
    WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKNavigationResponse, WKNavigationResponsePolicy, WKNavigationType, WKWebView,
};
use std::cell::Cell;
use tauri::AppHandle;

pub struct NavigationIvars {
    app: AppHandle,
    id: u32,
    active_navigation: Cell<usize>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NavigationIvars]
    pub struct NavigationDelegate;
    impl NavigationDelegate {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn properties_changed(&self, key: Option<&NSString>, object: Option<&objc2::runtime::AnyObject>, _change: Option<&objc2_foundation::NSDictionary>, _context: *mut std::ffi::c_void) {
            let Some(view) = object.and_then(|object| object.downcast_ref::<WKWebView>()) else { return; };
            match key.map(|key| key.to_string()).as_deref() {
                Some("title") => {
                    if let Some(title) = unsafe { view.title() }.filter(|title| !title.is_empty()) {
                        state::update_tab(&self.ivars().app, self.ivars().id, |tab| { tab.title = title.to_string(); });
                    }
                }
                Some("estimatedProgress") => {
                    let progress = unsafe { view.estimatedProgress() };
                    state::update_tab(&self.ivars().app, self.ivars().id, |tab| {
                        if tab.status == "loading" { tab.progress = tab.progress.max((progress.clamp(0.0, 1.0) * 100.0).round() / 100.0); }
                    });
                }
                _ => {}
            }
        }
    }
    unsafe impl NSObjectProtocol for NavigationDelegate {}
    unsafe impl WKNavigationDelegate for NavigationDelegate {
        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(&self, _view: &WKWebView, _action: &WKNavigationAction, download: &objc2_web_kit::WKDownload) { super::downloads::start(&self.ivars().app, download); }
        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(&self, _view: &WKWebView, _response: &WKNavigationResponse, download: &objc2_web_kit::WKDownload) { super::downloads::start(&self.ivars().app, download); }

        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(
            &self,
            _view: &WKWebView,
            action: &WKNavigationAction,
            handler: &Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let app = &self.ivars().app;
            let url = unsafe {
                action
                    .request()
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string())
            };
            let downloading = unsafe { action.shouldPerformDownload() };
            let blank = url.as_deref() == Some("about:blank");
            let allowed = blank || url.as_deref().is_some_and(|url| {
                    policy::guest_url(url, crate::browser::policy::dev_url(app)).is_ok()
                });
            policy::audit(
                "navigation",
                url.as_deref(),
                if allowed { "allowed" } else { "blocked" },
            );
            let main_frame = unsafe {
                action
                    .targetFrame()
                    .is_some_and(|frame| frame.isMainFrame())
            };
            if allowed && main_frame && !downloading && !blank {
                let kind = unsafe { action.navigationType() };
                super::registry::REGISTRY.with(|registry| {
                    if let Some(guest) = registry.borrow_mut().guests.get_mut(&self.ivars().id) {
                        // Redirects are Other; preserve the initiating history/reload decision.
                        if kind != WKNavigationType::Other {
                            guest.initial_position_pending = kind != WKNavigationType::BackForward && kind != WKNavigationType::Reload && kind != WKNavigationType::FormResubmitted;
                        }
                    }
                });
                state::update_tab(app, self.ivars().id, |state| {
                    state.url = url.clone();
                    if state.status != "loading" { state.progress = 0.0; }
                    state.status = "loading".into();
                    state.notice = None;
                });
            }
            if !allowed {
                state::update_tab(app, self.ivars().id, |state| {
                    state.notice = Some(
                        if downloading {
                            "实验浏览器不支持下载，请使用系统浏览器"
                        } else {
                            "已拦截不支持的协议或应用内部地址"
                        }
                        .into(),
                    );
                });
            }
            handler.call((if allowed {
                if downloading { WKNavigationActionPolicy::Download } else { WKNavigationActionPolicy::Allow }
            } else {
                WKNavigationActionPolicy::Cancel
            },));
        }
        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn response(
            &self,
            _view: &WKWebView,
            response: &WKNavigationResponse,
            handler: &Block<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            let attachment = unsafe {
                response
                    .response()
                    .downcast::<NSHTTPURLResponse>()
                    .ok()
                    .and_then(|response| {
                        response.valueForHTTPHeaderField(&NSString::from_str("Content-Disposition"))
                    })
                    .is_some_and(|value| {
                        value
                            .to_string()
                            .trim_start()
                            .to_ascii_lowercase()
                            .starts_with("attachment")
                    })
            };
            let allowed = unsafe { response.canShowMIMEType() } && !attachment;
            if !allowed && unsafe { response.isForMainFrame() } {
                publish(&self.ivars().app, self.ivars().id, _view, "failed", Some("正在准备下载".into()), false);
                policy::audit("download", None, "requested");
            }
            handler.call((if allowed {
                WKNavigationResponsePolicy::Allow
            } else {
                WKNavigationResponsePolicy::Download
            },));
        }
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn started(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            self.track(navigation);
            publish(&self.ivars().app, self.ivars().id, view, "loading", None, false);
        }
        #[unsafe(method(webView:didReceiveServerRedirectForProvisionalNavigation:))]
        fn redirected(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            if self.current(navigation) { publish(&self.ivars().app, self.ivars().id, view, "loading", None, true); }
        }
        #[unsafe(method(webView:didCommitNavigation:))]
        fn committed(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            if !self.current(navigation) { return; }
            publish(&self.ivars().app, self.ivars().id, view, "loading", None, true);
            super::reveal(self.ivars().id);
        }
        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, view: &WKWebView, navigation: Option<&WKNavigation>) {
            if !self.current(navigation) { return; }
            // Position once after initial styles/layout settle, never on intermediate redirects.
            super::browsing::center_initial_content(self.ivars().id, view);
            super::reveal(self.ivars().id);
            publish(&self.ivars().app, self.ivars().id, view, "ready", None, true);
            policy::audit("load", None, "finished");
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed_provisional(
            &self,
            view: &WKWebView,
            navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            if self.current(navigation) { failed(&self.ivars().app, self.ivars().id, view, error); }
        }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed(&self, view: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
            if self.current(navigation) { failed(&self.ivars().app, self.ivars().id, view, error); }
        }
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn terminated(&self, view: &WKWebView) {
            super::hide(self.ivars().id);
            publish(
                &self.ivars().app,
                self.ivars().id,
                view,
                "failed",
                Some("网页进程已退出，可刷新或使用系统浏览器".into()),
                false,
            );
            policy::audit("process", None, "terminated");
        }
    }
);

impl NavigationDelegate {
    pub(super) fn track(&self, navigation: Option<&WKNavigation>) {
        if let Some(navigation) = navigation {
            self.ivars()
                .active_navigation
                .set(navigation as *const WKNavigation as usize);
        }
    }
    fn current(&self, navigation: Option<&WKNavigation>) -> bool {
        navigation.is_none_or(|navigation| {
            self.ivars().active_navigation.get() == navigation as *const WKNavigation as usize
        })
    }
    pub fn new(marker: MainThreadMarker, app: AppHandle, id: u32) -> Retained<Self> {
        let object = marker.alloc::<Self>().set_ivars(NavigationIvars {
            app,
            id,
            active_navigation: Cell::new(0),
        });
        unsafe { msg_send![super(object), init] }
    }
}
