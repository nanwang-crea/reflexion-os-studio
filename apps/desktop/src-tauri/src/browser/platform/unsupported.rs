//! Explicit degradation; never instantiate a second webpage engine.
use crate::browser::state::Action;
use tauri::AppHandle;

pub fn available() -> bool {
    false
}
pub fn persistent_available() -> bool {
    false
}
pub fn attach(_: &AppHandle) -> Result<(), String> {
    Err(super::unavailable_notice().into())
}
pub fn control(_: &AppHandle, _: &Action) -> Result<(), String> {
    Err(super::unavailable_notice().into())
}
pub fn close_tab(_: u32) {}
pub fn dispose() {}
pub fn clearing() -> bool {
    false
}
pub fn clear_data(
    _: &AppHandle,
    _: bool,
    _: bool,
    done: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = done.send(Err("原生数据清理尚未适配本平台".into()));
}
