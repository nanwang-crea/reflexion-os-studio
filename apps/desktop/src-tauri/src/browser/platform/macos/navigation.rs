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
use tauri::AppHandle;

pub struct NavigationIvars {
    app: AppHandle,
    id: u32,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = NavigationIvars]
    pub struct NavigationDelegate;
    impl NavigationDelegate {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn title_changed(&self, _key: Option<&NSString>, object: Option<&objc2::runtime::AnyObject>, _change: Option<&objc2_foundation::NSDictionary>, _context: *mut std::ffi::c_void) {
            let Some(view) = object.and_then(|object| object.downcast_ref::<WKWebView>()) else { return; };
            if let Some(title) = unsafe { view.title() }.filter(|title| !title.is_empty()) {
                state::update_tab(&self.ivars().app, self.ivars().id, |tab| { tab.title = title.to_string(); });
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
            if !allowed {
                state::update_tab(&self.ivars().app, self.ivars().id, |state| {
                    super::hide(self.ivars().id);
                    state.status = "failed".into();
                    state.notice = Some("正在准备下载".into());
                });
                policy::audit("download", None, "blocked");
            }
            handler.call((if allowed {
                WKNavigationResponsePolicy::Allow
            } else {
                WKNavigationResponsePolicy::Download
            },));
        }
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn started(&self, view: &WKWebView, _navigation: Option<&WKNavigation>) {
            publish(&self.ivars().app, self.ivars().id, view, "loading", None);
        }
        #[unsafe(method(webView:didCommitNavigation:))]
        fn committed(&self, view: &WKWebView, _navigation: Option<&WKNavigation>) {
            super::browsing::center_initial_content(self.ivars().id, view);
            super::reveal(self.ivars().id);
        }
        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, view: &WKWebView, _navigation: Option<&WKNavigation>) {
            super::reveal(self.ivars().id);
            publish(&self.ivars().app, self.ivars().id, view, "ready", None);
            policy::audit("load", None, "finished");
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed_provisional(
            &self,
            view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            failed(&self.ivars().app, self.ivars().id, view, error);
        }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed(&self, view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            failed(&self.ivars().app, self.ivars().id, view, error);
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
            );
            policy::audit("process", None, "terminated");
        }
    }
);

impl NavigationDelegate {
    pub fn new(marker: MainThreadMarker, app: AppHandle, id: u32) -> Retained<Self> {
        let object = marker
            .alloc::<Self>()
            .set_ivars(NavigationIvars { app, id });
        unsafe { msg_send![super(object), init] }
    }
}

pub fn publish(app: &AppHandle, id: u32, view: &WKWebView, status: &str, notice: Option<String>) {
    unsafe {
        let current = view
            .URL()
            .and_then(|url| url.absoluteString())
            .map(|url| url.to_string())
            .filter(|url| url != "about:blank");
        state::update_tab(app, id, |state| {
            // Provisional failure may leave the previous URL: keep the requested target.
            if status == "ready" {
                if let Some(url) = current {
                    state.url = Some(url);
                }
            }
            if status == "ready" {
                if let Some(title) = view.title().filter(|title| !title.is_empty()) {
                    state.title = title.to_string();
                }
            }
            state.status = status.into();
            state.notice = notice;
            state.can_go_back = view.canGoBack();
            state.can_go_forward = view.canGoForward();
        });
    }
}
fn failed(app: &AppHandle, id: u32, view: &WKWebView, error: &NSError) {
    // NSURLErrorCancelled is expected for stop/superseded/blocked navigation.
    if error.code() == -999
        || state::snapshot(app)
            .tabs
            .iter()
            .any(|tab| tab.id == id && tab.status == "failed")
    {
        return;
    }
    super::hide(id);
    publish(
        app,
        id,
        view,
        "failed",
        Some("网页加载失败（网络、证书或站点兼容性），可重试或使用系统浏览器".into()),
    );
    policy::audit("load", None, "failed");
}
