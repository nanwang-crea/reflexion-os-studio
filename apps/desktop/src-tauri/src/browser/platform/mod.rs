//! One selected webpage engine; credential UI remains a separate native capability.
#[cfg(any(test, target_os = "windows", target_os = "linux"))]
mod guest_registry;
#[cfg(any(test, target_os = "windows", target_os = "linux"))]
mod guest_state;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(feature = "browser-spike", target_os = "macos"))]
#[path = "macos/passwords/mod.rs"]
mod passwords;
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod portable;
#[cfg(target_os = "windows")]
mod windows;

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
#[cfg(all(feature = "browser-spike", target_os = "macos"))]
pub use passwords::manage as manage_password;
#[cfg(any(
    all(target_os = "windows", not(feature = "cef-browser")),
    target_os = "linux"
))]
pub use portable::{attach, clear_data, clearing, close_tab, control, dispose};

#[cfg(not(any(
    all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    ),
    target_os = "windows",
    target_os = "linux"
)))]
pub fn available() -> bool {
    false
}
#[cfg(not(any(
    all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    ),
    target_os = "windows",
    target_os = "linux"
)))]
pub fn persistent_available() -> bool {
    false
}

#[cfg(not(any(
    all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    ),
    target_os = "windows",
    target_os = "linux"
)))]
mod unsupported {
    use crate::browser::state::Action;
    use tauri::AppHandle;
    pub fn attach(_: &AppHandle) -> Result<(), String> {
        Err("native adapter unavailable".into())
    }
    pub fn control(_: &AppHandle, _: &Action) -> Result<(), String> {
        Err("native adapter unavailable".into())
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
}
#[cfg(not(any(
    all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    ),
    target_os = "windows",
    target_os = "linux"
)))]
pub use unsupported::{attach, clear_data, clearing, close_tab, control, dispose};

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
