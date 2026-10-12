use crate::browser::state;
use std::{cell::Cell, rc::Rc};
use tauri::AppHandle;
use webview2_com::{
    HistoryChangedEventHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, NavigationStartingEventHandler, ProcessFailedEventHandler,
    SourceChangedEventHandler,
};
use windows::{
    core::{BOOL, PWSTR},
    Win32::System::Com::CoTaskMemFree,
};
use wry::{WebView, WebViewExtWindows};

pub(super) fn install(app: &AppHandle, id: u32, view: &WebView) -> Result<(), String> {
    let webview = view.webview();
    let active = Rc::new(Cell::new(0u64));
    let current = active.clone();
    let start_app = app.clone();
    let finish_app = app.clone();
    let history_app = app.clone();
    let failed_app = app.clone();
    let source_app = app.clone();
    let install = || -> windows::core::Result<()> {
        unsafe {
            let mut token = 0;
            webview.add_ProcessFailed(
                &ProcessFailedEventHandler::create(Box::new(move |_, _| {
                    state::update_tab(&failed_app, id, |tab| {
                        tab.status = "failed".into();
                        tab.progress = 0.0;
                        tab.notice = Some("网页进程异常，请重新加载".into());
                    });
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut navigation = 0;
                        args.NavigationId(&mut navigation)?;
                        current.set(navigation);
                        state::update_tab(&start_app, id, |tab| {
                            if tab.status != "loading" {
                                tab.progress = 0.0;
                            }
                            tab.status = "loading".into();
                            tab.notice = None;
                        });
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |view, args| {
                    if let (Some(view), Some(args)) = (view, args) {
                        let mut navigation = 0;
                        args.NavigationId(&mut navigation)?;
                        if navigation != active.get() {
                            return Ok(());
                        }
                        let mut success = BOOL::default();
                        args.IsSuccess(&mut success)?;
                        let url = source(&view)?;
                        state::update_tab(&finish_app, id, |tab| {
                            if success.as_bool() {
                                super::super::portable::loading(tab, &url, true);
                            } else {
                                tab.status = "failed".into();
                                tab.progress = 0.0;
                                tab.notice = Some("网页加载失败，可重试或使用系统浏览器".into());
                            }
                        });
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_SourceChanged(
                &SourceChangedEventHandler::create(Box::new(move |view, _| {
                    if let Some(view) = view {
                        let url = source(&view)?;
                        if crate::browser::policy::web_url(&url).is_ok() {
                            state::update_tab(&source_app, id, |tab| tab.url = Some(url.clone()));
                        }
                    }
                    Ok(())
                })),
                &mut token,
            )?;
            webview.add_HistoryChanged(
                &HistoryChangedEventHandler::create(Box::new(move |view, _| {
                    if let Some(view) = view {
                        let mut back = BOOL::default();
                        let mut forward = BOOL::default();
                        view.CanGoBack(&mut back)?;
                        view.CanGoForward(&mut forward)?;
                        state::update_tab(&history_app, id, |tab| {
                            tab.can_go_back = back.as_bool();
                            tab.can_go_forward = forward.as_bool();
                        });
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    };
    install().map_err(|_| "无法安装 WebView2 导航状态回调".into())
}

fn source(view: &ICoreWebView2) -> windows::core::Result<String> {
    text(|pointer| unsafe { view.Source(pointer) })
}

pub(super) fn text(
    read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>,
) -> windows::core::Result<String> {
    let mut pointer = PWSTR::null();
    read(&mut pointer)?;
    if pointer.is_null() {
        return Ok(String::new());
    }
    unsafe {
        let result = pointer.to_string();
        CoTaskMemFree(Some(pointer.as_ptr().cast()));
        result.map_err(|_| {
            windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32))
        })
    }
}
