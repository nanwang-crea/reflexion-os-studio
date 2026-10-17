//! CEF is the only embedded webpage engine. Other builds expose system browsing.
#[cfg(all(feature = "cef-browser", target_os = "macos"))]
#[path = "macos/passwords/mod.rs"]
mod passwords;
#[cfg(all(feature = "cef-browser", target_os = "macos"))]
pub use passwords::manage as manage_password;

#[cfg(all(
    feature = "cef-browser",
    any(target_os = "macos", target_os = "windows")
))]
pub use crate::browser::cef::clearing::{active as clearing, clear as clear_data};
#[cfg(all(feature = "cef-browser", target_os = "macos"))]
pub use crate::browser::cef::credentials::{fill, install_cookies};
#[cfg(all(
    feature = "cef-browser",
    any(target_os = "macos", target_os = "windows")
))]
pub use crate::browser::cef::{
    attach, close_tab, control, dispose, ready as available, ready as persistent_available,
};

#[cfg(not(all(
    feature = "cef-browser",
    any(target_os = "macos", target_os = "windows")
)))]
mod unsupported;
#[cfg(not(all(
    feature = "cef-browser",
    any(target_os = "macos", target_os = "windows")
)))]
pub use unsupported::{
    attach, available, clear_data, clearing, close_tab, control, dispose, persistent_available,
};

pub fn downloads() -> Vec<crate::browser::downloads::Record> {
    crate::browser::downloads::transfers::list()
}
pub fn download_action(id: u64, kind: &str) -> Result<(), String> {
    crate::browser::downloads::transfers::action(id, kind)
}
pub fn unavailable_notice() -> &'static str {
    if cfg!(all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    )) {
        "内置 CEF 浏览器未能启动，请检查资源是否完整或重新安装"
    } else {
        "本平台的内嵌浏览器尚未启用，请使用系统浏览器"
    }
}
