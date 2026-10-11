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
            _view: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            _kind: WKMediaCaptureType,
            handler: &Block<dyn Fn(WKPermissionDecision)>,
        ) {
            handler.call((WKPermissionDecision::Deny,));
            policy::audit("media", None, "blocked");
        }
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        unsafe fn new_window(
            &self,
            _view: &WKWebView,
            _config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            let request = action.request();
            let url = request
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string());
            let app = &self.ivars().app;
            let allowed = url.as_deref().is_some_and(|raw| {
                policy::guest_url(raw, crate::browser::policy::dev_url(app)).is_ok()
            });
            if allowed {
                let _ = crate::browser::window::control(app, state::Action::Newtab { url });
            }
            policy::audit(
                "new-window",
                None,
                if allowed { "new-tab" } else { "blocked" },
            );
            None
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
