use crate::browser::{policy, state};
use objc2::rc::Retained;
use objc2_web_kit::{WKNavigationAction, WKWebView, WKWebViewConfiguration};
use tauri::AppHandle;

pub(super) fn create(
    app: &AppHandle,
    opener: u32,
    config: &WKWebViewConfiguration,
    action: &WKNavigationAction,
) -> Option<Retained<WKWebView>> {
    let url = unsafe { action.request().URL().and_then(|url| url.absoluteString()) }
        .map(|url| url.to_string());
    let allowed = url.as_deref().is_some_and(|raw| {
        raw == "about:blank" || policy::guest_url(raw, policy::dev_url(app)).is_ok()
    });
    if !allowed {
        state::update_tab(app, opener, |tab| {
            tab.notice = Some("已拦截不支持的新窗口地址".into());
        });
        policy::audit("new-window", None, "blocked");
        return None;
    }
    let url = url.filter(|url| url != "about:blank");
    let mut result = Ok(0);
    state::update(app, |snapshot| {
        result = snapshot.add_tab(url);
    });
    let id = match result {
        Ok(id) => id,
        Err(_) => {
            state::update_tab(app, opener, |tab| {
                tab.notice = Some("无法创建新标签，请关闭部分标签后重试".into());
            });
            return None;
        }
    };
    match super::attach_view(app, Some(config), false) {
        Ok(view) => {
            // Return WebKit's new view so its original request keeps POST, referrer and opener semantics.
            policy::audit("new-window", None, "new-tab");
            Some(view)
        }
        Err(_) => {
            super::registry::close_tab(id);
            state::update(app, |snapshot| {
                let _ = snapshot.close_tab(id);
                let _ = snapshot.select_tab(opener);
            });
            let _ = super::attach(app);
            state::update_tab(app, opener, |tab| {
                tab.notice = Some("无法创建网页视图，请重试".into());
            });
            None
        }
    }
}
