use super::super::portable::clearing;
use std::{cell::RefCell, path::PathBuf, sync::mpsc::Sender};
use tauri::{AppHandle, Manager};
use webview2_com::{
    BrowserProcessExitedEventHandler, ClearBrowsingDataCompletedHandler,
    Microsoft::Web::WebView2::Win32::*,
};
use windows::core::Interface;
use wry::{WebView, WebViewExtWindows};
thread_local! {
    static DIRECTORY: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static PROFILE: RefCell<Option<ICoreWebView2Profile2>> = const { RefCell::new(None) };
}

pub(super) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    DIRECTORY.with(|directory| {
        let mut directory = directory.borrow_mut();
        if let Some(path) = &*directory {
            return Ok(path.clone());
        }
        let path = if crate::browser::state::preferences(app).storage_mode == "persistent" {
            std::env::var_os("REFLEXION_DATA_DIR")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(|| app.path().app_data_dir())
                .map_err(|_| "数据目录不可用")?
                .join("browser-profile")
        } else {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "浏览会话时钟不可用")?
                .as_nanos();
            app.path()
                .app_cache_dir()
                .map_err(|_| "缓存目录不可用")?
                .join("browser-guests")
                .join(format!("{}-{nonce}", std::process::id()))
        };
        std::fs::create_dir_all(&path).map_err(|_| "无法创建独立浏览配置")?;
        *directory = Some(path.clone());
        Ok(path)
    })
}

pub(super) fn remember(
    view: &WebView,
    directory: &std::path::Path,
    temporary: bool,
) -> Result<(), String> {
    let profile = unsafe {
        view.webview()
            .cast::<ICoreWebView2_13>()
            .and_then(|view| view.Profile())
    }
    .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
    .map_err(|_| "浏览数据管理不可用")?;
    if temporary {
        let directory = directory.to_path_buf();
        let environment = unsafe {
            view.webview()
                .cast::<ICoreWebView2_2>()
                .and_then(|view| view.Environment())
        }
        .and_then(|environment| environment.cast::<ICoreWebView2Environment5>());
        let environment = environment.map_err(|_| "临时配置回收接口不可用")?;
        unsafe {
            let mut token = 0;
            environment
                .add_BrowserProcessExited(
                    &BrowserProcessExitedEventHandler::create(Box::new(move |_, _| {
                        let current =
                            DIRECTORY.with(|current| current.borrow().as_ref() == Some(&directory));
                        if !current {
                            let _ = std::fs::remove_dir_all(&directory);
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|_| "临时配置回收接线失败")?;
        }
    }
    PROFILE.with(|stored| *stored.borrow_mut() = Some(profile));
    Ok(())
}

pub(super) fn dispose() {
    if !clearing::active() {
        PROFILE.with(|profile| {
            profile.borrow_mut().take();
        });
        // WebView2 can still hold the folder while its process exits. Never reuse a temporary folder.
        DIRECTORY.with(|directory| {
            directory.borrow_mut().take();
        });
    }
}

pub(crate) fn clear_data(
    app: &AppHandle,
    website_data: bool,
    cache: bool,
    done: Sender<Result<(), String>>,
) {
    let profile = PROFILE.with(|profile| profile.borrow().clone());
    let Some(profile) = profile else {
        let _ = done.send(Err("请先建立浏览数据容器".into()));
        return;
    };
    if let Err(error) = clearing::begin(app) {
        let _ = done.send(Err(error));
        return;
    }
    let mut selected = COREWEBVIEW2_BROWSING_DATA_KINDS(0);
    if cache {
        selected |= COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
            | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE;
    }
    if website_data {
        selected |= COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES
            | COREWEBVIEW2_BROWSING_DATA_KINDS_FILE_SYSTEMS
            | COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB
            | COREWEBVIEW2_BROWSING_DATA_KINDS_LOCAL_STORAGE
            | COREWEBVIEW2_BROWSING_DATA_KINDS_WEB_SQL;
    }
    let completion = done.clone();
    let result = unsafe {
        profile.ClearBrowsingData(
            selected,
            &ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                clearing::finish();
                let _ = completion.send(result.map_err(|_| "网站数据清理失败".into()));
                Ok(())
            })),
        )
    };
    if result.is_err() {
        clearing::finish();
        let _ = done.send(Err("无法启动网站数据清理".into()));
    }
}
