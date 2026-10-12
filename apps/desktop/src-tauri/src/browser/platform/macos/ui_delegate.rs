use crate::browser::{policy, state};
use block2::Block;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{Bool, NSObject},
    DefinedClass, MainThreadOnly,
};
use objc2_foundation::{MainThreadMarker, NSArray, NSObjectProtocol, NSString, NSURL};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKOpenPanelParameters,
    WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration,
    WKWindowFeatures,
};
use tauri::AppHandle;

pub struct UiIvars {
    app: AppHandle,
    id: u32,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = UiIvars]
    pub struct UiDelegate;
    unsafe impl NSObjectProtocol for UiDelegate {}
    unsafe impl WKUIDelegate for UiDelegate {
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn file_panel(
            &self,
            _view: &WKWebView,
            _params: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            handler: &Block<dyn Fn(*const NSArray<NSURL>)>,
        ) {
            handler.call((std::ptr::null(),));
            state::update_tab(&self.ivars().app, self.ivars().id, |state| {
                state.notice = Some("实验浏览器不支持上传文件".into());
            });
            policy::audit("upload", None, "blocked");
        }
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media(
            &self,
            view: &WKWebView,
            origin: &WKSecurityOrigin,
            frame: &WKFrameInfo,
            kind: WKMediaCaptureType,
            handler: &Block<dyn Fn(WKPermissionDecision)>,
        ) {
            let current = unsafe { view.URL().and_then(|u| u.absoluteString()) }
                .and_then(|s| url::Url::parse(&s.to_string()).ok())
                .filter(|u| u.scheme() == "https");
            let source = unsafe {
                format!(
                    "{}://{}{}",
                    origin.protocol(),
                    origin.host(),
                    if origin.port() == 0 || origin.port() == 443 {
                        String::new()
                    } else {
                        format!(":{}", origin.port())
                    }
                )
            };
            let prefs = state::preferences(&self.ivars().app);
            let camera = kind == WKMediaCaptureType::Camera
                || kind == WKMediaCaptureType::CameraAndMicrophone;
            let microphone = kind == WKMediaCaptureType::Microphone
                || kind == WKMediaCaptureType::CameraAndMicrophone;
            let allowed = super::media_available()
                && unsafe { frame.isMainFrame() }
                && current
                    .as_ref()
                    .is_some_and(|u| u.origin().ascii_serialization() == source)
                && (!camera || prefs.asks(&source, "camera"))
                && (!microphone || prefs.asks(&source, "microphone"))
                && super::contact::confirm(
                    "网站媒体权限",
                    &format!(
                        "{} 请求{}{}。仅允许此次请求？",
                        source,
                        if camera { "摄像头" } else { "" },
                        if microphone { "麦克风" } else { "" }
                    ),
                );
            let unchanged = unsafe { view.URL().and_then(|u| u.absoluteString()) }
                .and_then(|s| url::Url::parse(&s.to_string()).ok())
                .is_some_and(|u| u.origin().ascii_serialization() == source);
            let prefs = state::preferences(&self.ivars().app);
            let unchanged = unchanged
                && state::snapshot(&self.ivars().app).active_tab_id == Some(self.ivars().id)
                && (!camera || prefs.asks(&source, "camera"))
                && (!microphone || prefs.asks(&source, "microphone"));
            handler.call((if allowed && unchanged {
                WKPermissionDecision::Grant
            } else {
                WKPermissionDecision::Deny
            },));
            policy::audit(
                "media",
                None,
                if allowed && unchanged {
                    "allowed-once"
                } else {
                    "blocked"
                },
            );
        }
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        unsafe fn new_window(
            &self,
            _view: &WKWebView,
            config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            super::popup::create(&self.ivars().app, self.ivars().id, config, action)
        }
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(
            &self,
            _view: &WKWebView,
            _message: &NSString,
            _frame: &WKFrameInfo,
            handler: &Block<dyn Fn()>,
        ) {
            handler.call(());
        }
        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(
            &self,
            _view: &WKWebView,
            _message: &NSString,
            _frame: &WKFrameInfo,
            handler: &Block<dyn Fn(Bool)>,
        ) {
            handler.call((Bool::NO,));
        }
        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(
            &self,
            _view: &WKWebView,
            _prompt: &NSString,
            _default: Option<&NSString>,
            _frame: &WKFrameInfo,
            handler: &Block<dyn Fn(*const NSString)>,
        ) {
            handler.call((std::ptr::null(),));
        }
    }
);
impl UiDelegate {
    pub fn new(marker: MainThreadMarker, app: AppHandle, id: u32) -> Retained<Self> {
        let object = marker.alloc::<Self>().set_ivars(UiIvars { app, id });
        unsafe { msg_send![super(object), init] }
    }
}
