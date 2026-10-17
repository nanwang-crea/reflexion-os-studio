mod destination;
mod reveal;
use crate::browser::downloads::Record;
use std::{cell::RefCell, collections::BTreeMap, path::PathBuf};
use tauri::{AppHandle, Emitter};

struct Entry {
    app: AppHandle,
    record: Record,
    stage: PathBuf,
    target: PathBuf,
    cancel: Option<Box<dyn FnOnce()>>,
}
#[derive(Default)]
struct Downloads {
    entries: BTreeMap<u64, Entry>,
    next: u64,
    pending: usize,
}
thread_local! { static DOWNLOADS: RefCell<Downloads> = RefCell::new(Downloads::default()); }

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn prepare(app: &AppHandle, source: &str, name: &str) -> Result<(u64, PathBuf), String> {
    if full() {
        return Err("下载记录或进行中下载已达上限".into());
    }
    register(app, destination::prepare(app, source, name)?)
}

/// CEF callbacks run on the UI thread. The blocking dialog must run off that thread,
/// while the thread-local transfer registry and CEF continuation stay on the UI thread.
#[cfg(feature = "cef-browser")]
pub(crate) fn prepare_async(
    app: &AppHandle,
    source: String,
    name: String,
    done: impl FnOnce(Result<(u64, PathBuf), String>) + Send + 'static,
) {
    if full() {
        done(Err("下载记录或进行中下载已达上限".into()));
        return;
    }
    DOWNLOADS.with(|downloads| downloads.borrow_mut().pending += 1);
    let revision = crate::browser::state::snapshot(app).revision;
    let app = app.clone();
    std::thread::spawn(move || {
        let destination = destination::prepare(&app, &source, &name);
        let stage = destination.as_ref().ok().map(|(_, stage, _)| stage.clone());
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                DOWNLOADS.with(|downloads| downloads.borrow_mut().pending -= 1);
                let result = destination.and_then(|destination| {
                    if crate::browser::state::snapshot(&handle).revision != revision {
                        destination::cleanup(&destination.1);
                        return Err("下载页面已切换，请重试".into());
                    }
                    register(&handle, destination)
                });
                done(result);
            })
            .is_err()
        {
            if let Some(stage) = stage {
                destination::cleanup(&stage);
            }
        }
    });
}

fn register(
    app: &AppHandle,
    destination: (String, PathBuf, PathBuf),
) -> Result<(u64, PathBuf), String> {
    let (origin, stage, target) = destination;
    // The native save dialog can dispatch another download while it is open.
    if full() {
        destination::cleanup(&stage);
        return Err("下载记录或进行中下载已达上限".into());
    }
    let result = DOWNLOADS.with(|d| {
        let mut d = d.borrow_mut();
        d.next = d.next.checked_add(1).ok_or("下载编号已耗尽")?;
        let id = d.next;
        d.entries.insert(
            id,
            Entry {
                app: app.clone(),
                record: Record {
                    id,
                    origin,
                    filename: target
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    path: None,
                    status: "active".into(),
                    received_bytes: 0,
                    total_bytes: None,
                    notice: None,
                },
                stage: stage.clone(),
                target,
                cancel: None,
            },
        );
        Ok((id, stage.clone()))
    });
    if result.is_err() {
        destination::cleanup(&stage);
    }
    if result.is_ok() {
        let _ = app.emit_to("main", "browser:downloads", ());
    }
    result
}

fn full() -> bool {
    DOWNLOADS.with(|d| {
        let d = d.borrow();
        d.entries.len() + d.pending >= 200
            || d.pending
                + d.entries
                    .values()
                    .filter(|e| e.record.status == "active")
                    .count()
                >= 8
    })
}

pub(crate) fn settled(id: u64, success: bool, stage: &std::path::Path) {
    finish(id, success);
    // Also runs after records are removed/disposed; native handles may have held the file.
    destination::cleanup(stage);
}

pub(crate) fn cancellation(id: u64, cancel: impl FnOnce() + 'static) -> bool {
    let mut cancel: Option<Box<dyn FnOnce()>> = Some(Box::new(cancel));
    let attached = DOWNLOADS.with(|d| {
        let mut d = d.borrow_mut();
        let Some(entry) = d
            .entries
            .get_mut(&id)
            .filter(|entry| entry.record.status == "active" && entry.cancel.is_none())
        else {
            return false;
        };
        entry.cancel = cancel.take();
        true
    });
    // A cancellation can arrive before native setup finishes. Do not start that transfer.
    if let Some(cancel) = cancel {
        cancel();
    }
    attached
}

pub(crate) fn progress(id: u64, received: u64, total: Option<u64>) {
    DOWNLOADS.with(|d| {
        if let Some(e) = d
            .borrow_mut()
            .entries
            .get_mut(&id)
            .filter(|e| e.record.status == "active")
        {
            e.record.received_bytes = e.record.received_bytes.max(received);
            e.record.total_bytes = total;
        }
    });
}
pub(crate) fn finish(id: u64, success: bool) {
    let app = DOWNLOADS.with(|d| {
        let mut d = d.borrow_mut();
        let Some(e) = d
            .entries
            .get_mut(&id)
            .filter(|e| e.record.status == "active")
        else {
            return None;
        };
        let result = if success {
            crate::browser::downloads::policy::publish(&e.stage, &e.target)
        } else {
            Err("下载失败或已取消".into())
        };
        e.record.status = if result.is_ok() {
            "completed"
        } else {
            "failed"
        }
        .into();
        if result.is_ok() {
            e.record.path = Some(e.target.to_string_lossy().into());
        }
        e.record.notice = result.err();
        let cancel = e.cancel.take();
        destination::cleanup(&e.stage);
        Some((e.app.clone(), cancel))
    });
    if let Some((app, cancel)) = app {
        // Releasing a native operation can run callbacks; release the borrow first.
        drop(cancel);
        let _ = app.emit_to("main", "browser:downloads", ());
    }
}
pub fn list() -> Vec<Record> {
    DOWNLOADS.with(|d| {
        d.borrow()
            .entries
            .values()
            .map(|e| e.record.clone())
            .collect()
    })
}

pub fn action(id: u64, kind: &str) -> Result<(), String> {
    match kind {
        "cancel" => {
            let cancel = DOWNLOADS.with(|d| {
                let mut d = d.borrow_mut();
                let e = d.entries.get_mut(&id).ok_or("下载记录已不存在")?;
                if e.record.status != "active" {
                    return Err("下载已结束".to_string());
                }
                e.record.status = "cancelled".into();
                Ok((e.cancel.take(), e.stage.clone()))
            })?;
            if let Some(callback) = cancel.0 {
                callback();
            }
            destination::cleanup(&cancel.1);
        }
        "remove" => {
            let entry = DOWNLOADS.with(|d| {
                let mut d = d.borrow_mut();
                if d.entries
                    .get(&id)
                    .is_some_and(|e| e.record.status == "active")
                {
                    return Err("请先取消下载".into());
                }
                d.entries.remove(&id).ok_or("下载记录已不存在")
            })?;
            destination::cleanup(&entry.stage);
        }
        "reveal" => {
            let path = DOWNLOADS
                .with(|d| {
                    d.borrow()
                        .entries
                        .get(&id)
                        .filter(|e| e.record.status == "completed")
                        .and_then(|e| e.record.path.clone())
                })
                .ok_or("下载尚未完成")?;
            reveal::file(&path)?;
        }
        _ => return Err("未知下载操作".into()),
    }
    Ok(())
}
pub(crate) fn dispose() {
    let entries = DOWNLOADS.with(|d| std::mem::take(&mut d.borrow_mut().entries));
    // Never reuse IDs: late native callbacks must not finish a newer download.
    for mut entry in entries.into_values() {
        if let Some(cancel) = entry.cancel.take() {
            cancel();
        }
        destination::cleanup(&entry.stage);
    }
}
