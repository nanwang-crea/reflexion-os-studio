use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::Sender,
};
use tauri::AppHandle;

static CLEARING: AtomicBool = AtomicBool::new(false);
pub(crate) fn active() -> bool {
    CLEARING.load(Ordering::SeqCst)
}
pub(crate) fn finish() {
    CLEARING.store(false, Ordering::SeqCst);
}

pub(crate) fn begin(app: &AppHandle) -> Result<(), String> {
    if CLEARING.swap(true, Ordering::SeqCst) {
        return Err("浏览数据正在清理".into());
    }
    if let Err(error) = crate::browser::window::control(app, crate::browser::state::Action::Close) {
        finish();
        return Err(error);
    }
    Ok(())
}

pub fn clear_data(
    app: &AppHandle,
    website_data: bool,
    cache: bool,
    done: Sender<Result<(), String>>,
) {
    #[cfg(target_os = "windows")]
    super::super::windows::clear_data(app, website_data, cache, done);
    #[cfg(target_os = "linux")]
    super::super::linux::clear_data(app, website_data, cache, done);
}
