use crate::browser::{
    policy,
    state::{self, Tab},
};
use objc2_foundation::NSError;
use objc2_web_kit::WKWebView;
use tauri::AppHandle;

fn apply(tab: &mut Tab, status: &str, url: Option<String>, progress: f64, notice: Option<String>) {
    if let Some(url) = url.filter(|url| policy::web_url(url).is_ok()) {
        tab.url = Some(url);
    }
    tab.progress = if status == "loading" {
        tab.progress.max(progress.clamp(0.0, 1.0))
    } else {
        0.0
    };
    tab.status = status.into();
    tab.notice = notice;
}

pub(super) fn publish(
    app: &AppHandle,
    id: u32,
    view: &WKWebView,
    status: &str,
    notice: Option<String>,
    resolve_url: bool,
) {
    unsafe {
        let current = if resolve_url {
            view.URL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string())
        } else {
            None
        };
        state::update_tab(app, id, |tab| {
            apply(tab, status, current, view.estimatedProgress(), notice);
            if status == "ready" {
                if let Some(title) = view.title().filter(|title| !title.is_empty()) {
                    tab.title = title.to_string();
                }
            }
            tab.can_go_back = view.canGoBack();
            tab.can_go_forward = view.canGoForward();
        });
    }
}

pub(super) fn failed(app: &AppHandle, id: u32, view: &WKWebView, error: &NSError) {
    if error.code() == -999 {
        return;
    }
    // Preserve any committed document; a provisional failure does not destroy the previous page.
    publish(
        app,
        id,
        view,
        "failed",
        Some("网页加载失败（网络、证书或站点兼容性），可重试或使用系统浏览器".into()),
        false,
    );
    policy::audit("load", None, "failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tab() -> Tab {
        Tab {
            id: 1,
            title: "Page".into(),
            status: "loading".into(),
            progress: 0.4,
            url: Some("http://example.com/".into()),
            can_go_back: false,
            can_go_forward: false,
            notice: None,
        }
    }
    #[test]
    fn redirects_update_actual_protocol_before_finishing_without_resetting_progress() {
        let mut tab = tab();
        apply(
            &mut tab,
            "loading",
            Some("https://example.com/".into()),
            0.2,
            None,
        );
        assert_eq!(tab.url.as_deref(), Some("https://example.com/"));
        assert_eq!(tab.status, "loading");
        assert_eq!(tab.progress, 0.4);
        apply(
            &mut tab,
            "ready",
            Some("https://example.com/".into()),
            1.0,
            None,
        );
        assert_eq!(tab.progress, 0.0);
    }
    #[test]
    fn provisional_failure_preserves_requested_target_and_non_web_urls_are_not_published() {
        let mut tab = tab();
        apply(&mut tab, "failed", None, 0.8, Some("failed".into()));
        assert_eq!(tab.url.as_deref(), Some("http://example.com/"));
        assert_eq!(tab.progress, 0.0);
        apply(&mut tab, "ready", Some("about:blank".into()), 1.0, None);
        assert_eq!(tab.url.as_deref(), Some("http://example.com/"));
    }
}
