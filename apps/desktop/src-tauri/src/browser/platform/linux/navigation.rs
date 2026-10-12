use crate::browser::state;
use gtk::prelude::*;
use tauri::AppHandle;
use webkit2gtk::{
    NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt, PolicyDecisionType,
    URIRequestExt, WebView, WebViewExt,
};

pub(super) fn connect(app: &AppHandle, id: u32, view: &WebView) {
    let app_navigation = app.clone();
    view.connect_decide_policy(move |_, decision, kind| {
        if matches!(
            kind,
            PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction
        ) {
            let allowed = decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|decision| decision.navigation_action())
                .and_then(|action| action.request())
                .and_then(|request| request.uri())
                .is_some_and(|url| {
                    super::super::portable::navigation_allowed(&app_navigation, &url)
                });
            if !allowed {
                decision.ignore();
                return true;
            }
        }
        false
    });
    let app_load = app.clone();
    view.connect_load_changed(move |view, event| {
        if let Some(url) = view.uri() {
            state::update_tab(&app_load, id, |tab| {
                if event == webkit2gtk::LoadEvent::Started {
                    tab.progress = 0.0;
                }
                if event != webkit2gtk::LoadEvent::Finished || tab.status != "failed" {
                    super::super::portable::loading(
                        tab,
                        &url,
                        event == webkit2gtk::LoadEvent::Finished,
                    );
                }
                tab.can_go_back = view.can_go_back();
                tab.can_go_forward = view.can_go_forward();
            });
        }
    });
    let app_title = app.clone();
    view.connect_title_notify(move |view| {
        if let Some(title) = view.title().filter(|t| !t.is_empty()) {
            state::update_tab(&app_title, id, |tab| tab.title = title.into());
        }
    });
    let app_progress = app.clone();
    view.connect_estimated_load_progress_notify(move |view| {
        state::update_tab(&app_progress, id, |tab| {
            if tab.status == "loading" {
                tab.progress = tab.progress.max(view.estimated_load_progress());
            }
        });
    });
    let app_terminated = app.clone();
    view.connect_web_process_terminated(move |_, _| {
        state::update_tab(&app_terminated, id, |tab| {
            tab.status = "failed".into();
            tab.progress = 0.0;
            tab.notice = Some("网页进程已退出，请重新加载".into());
        });
    });
    let app_failure = app.clone();
    view.connect_load_failed(move |_, _, _, error| {
        if error.matches(webkit2gtk::NetworkError::Cancelled) {
            return true;
        }
        state::update_tab(&app_failure, id, |tab| {
            tab.status = "failed".into();
            tab.progress = 0.0;
            tab.notice = Some("网页加载失败，可重试或使用系统浏览器".into());
        });
        true
    });
}
