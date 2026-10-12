mod delegate;
mod destination;
use crate::browser::{downloads::policy, state};
use block2::Block;
use delegate::{DownloadDelegate, DownloadIvars};
use destination::choose;
use objc2::{
    msg_send, rc::Retained, runtime::ProtocolObject, DefinedClass, MainThreadOnly, Message,
};

use objc2_foundation::{
    MainThreadMarker, NSData, NSError, NSObjectProtocol, NSProgressReporting, NSString,
    NSURLResponse, NSURL,
};
use objc2_web_kit::{WKDownload, WKDownloadDelegate};
use std::{cell::RefCell, collections::HashMap, path::PathBuf};
use tauri::{AppHandle, Emitter, Manager};

struct Transfer {
    app: AppHandle,
    download: Retained<WKDownload>,
    _delegate: Retained<DownloadDelegate>,
    record: super::super::super::downloads::Record,
    staging: Option<PathBuf>,
    destination: Option<PathBuf>,
}
thread_local! { static TRANSFERS: RefCell<HashMap<usize, Transfer>> = RefCell::new(HashMap::new()); }

pub fn start(app: &AppHandle, download: &WKDownload) {
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    let id = download as *const WKDownload as usize;
    let origin = unsafe {
        download
            .originalRequest()
            .and_then(|r| r.URL())
            .and_then(|u| u.absoluteString())
    }
    .and_then(|u| {
        crate::browser::policy::guest_url(&u.to_string(), crate::browser::policy::dev_url(app)).ok()
    })
    .map(|u| u.origin().ascii_serialization());
    if origin.is_none()
        || TRANSFERS.with(|r| {
            let r = r.borrow();
            r.len() >= 200
                || r.values()
                    .filter(|t| matches!(t.record.status.as_str(), "pending" | "active"))
                    .count()
                    >= 8
        })
    {
        unsafe {
            download.cancel(None);
        }
        return;
    }
    let delegate = marker.alloc::<DownloadDelegate>().set_ivars(DownloadIvars {
        app: app.clone(),
        id,
    });
    let delegate: Retained<DownloadDelegate> = unsafe { msg_send![super(delegate), init] };
    unsafe {
        download.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }
    TRANSFERS.with(|r| {
        r.borrow_mut().insert(
            id,
            Transfer {
                app: app.clone(),
                download: download.retain(),
                _delegate: delegate,
                record: crate::browser::downloads::Record {
                    id: id as u64,
                    origin: origin.unwrap(),
                    filename: "download".into(),
                    path: None,
                    status: "pending".into(),
                    received_bytes: 0,
                    total_bytes: None,
                    notice: None,
                },
                staging: None,
                destination: None,
            },
        )
    });
}
fn finish(id: usize, status: &str, notice: Option<String>) {
    let app = TRANSFERS.with(|r| r.borrow().get(&id).map(|t| t.app.clone()));
    TRANSFERS.with(|r| {
        if let Some(t) = r.borrow_mut().get_mut(&id) {
            if matches!(
                t.record.status.as_str(),
                "completed" | "cancelled" | "failed"
            ) {
                return;
            }
            t.record.status = status.into();
            t.record.notice = notice;
            if let Some(stage) = t.staging.take() {
                let _ = std::fs::remove_file(&stage);
                if let Some(parent) = stage.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
    });
    if let Some(app) = app {
        let _ = app.emit_to("main", "browser:downloads", ());
    }
}
pub fn list() -> Vec<crate::browser::downloads::Record> {
    TRANSFERS.with(|r| {
        r.borrow_mut()
            .values_mut()
            .map(|t| {
                let progress = t.download.progress();
                t.record.received_bytes = progress.completedUnitCount().max(0) as u64;
                t.record.total_bytes =
                    (progress.totalUnitCount() > 0).then_some(progress.totalUnitCount() as u64);
                t.record.clone()
            })
            .collect()
    })
}
pub fn action(id: u64, kind: &str) -> Result<(), String> {
    let download = TRANSFERS
        .with(|r| r.borrow().get(&(id as usize)).map(|t| t.download.clone()))
        .ok_or("下载记录不存在")?;
    match kind {
        "cancel" => {
            finish(id as usize, "cancelled", Some("已取消下载".into()));
            unsafe {
                download.cancel(None);
            }
        }
        "remove" => {
            let active = TRANSFERS.with(|r| {
                r.borrow()
                    .get(&(id as usize))
                    .is_some_and(|t| matches!(t.record.status.as_str(), "active" | "pending"))
            });
            if active {
                return Err("请先取消下载".into());
            }
            TRANSFERS.with(|r| {
                r.borrow_mut().remove(&(id as usize));
            });
        }
        "reveal" => {
            let path = TRANSFERS
                .with(|r| {
                    r.borrow()
                        .get(&(id as usize))
                        .filter(|t| t.record.status == "completed")
                        .and_then(|t| t.record.path.clone())
                })
                .ok_or("下载尚未完成")?;
            let path = std::path::PathBuf::from(path)
                .canonicalize()
                .map_err(|_| "下载文件已不存在")?;
            if policy::sensitive(&path) {
                return Err("禁止打开此路径".into());
            }
            std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(path)
                .spawn()
                .map_err(|_| "无法在 Finder 中显示文件")?;
        }
        _ => return Err("不支持此下载操作".into()),
    }
    Ok(())
}

pub fn cancel_all() {
    let ids = TRANSFERS.with(|r| {
        r.borrow()
            .values()
            .filter(|t| matches!(t.record.status.as_str(), "pending" | "active"))
            .map(|t| t.record.id)
            .collect::<Vec<_>>()
    });
    for id in ids {
        let _ = action(id, "cancel");
    }
}
