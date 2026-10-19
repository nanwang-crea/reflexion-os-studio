mod application;
pub mod bridge;
pub mod clearing;
mod client;
#[cfg(target_os = "macos")]
mod cocoa;
mod contact;
pub use contact::fill as fill_contact;
#[cfg(target_os = "macos")]
mod container;
mod contexts;
#[cfg(target_os = "macos")]
pub mod credentials;
mod downloads;
mod handles;
mod input;
mod lifecycle;
mod network;
#[cfg(feature = "cef-acceptance")]
pub mod ownership_probe;
mod popup;
mod pump;
mod registry;
mod storage;
mod viewport;

use ::cef::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU16, Ordering},
    OnceLock,
};
use tauri::Manager;

static LOADED: AtomicBool = AtomicBool::new(false);
static READY: AtomicBool = AtomicBool::new(false);
static PORT: AtomicU16 = AtomicU16::new(0);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(target_os = "macos")]
static FRAMEWORK: OnceLock<std::path::PathBuf> = OnceLock::new();
#[cfg(target_os = "windows")]
pub static SANDBOX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
pub fn ready() -> bool {
    READY.load(Ordering::Acquire)
}

pub fn distribution() -> Result<std::path::PathBuf, String> {
    cef::sys::get_cef_dir().ok_or_else(|| "CEF distribution unavailable".into())
}
pub fn bootstrap() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let executable = std::env::current_exe().map_err(|_| "executable unavailable")?;
        let bundled = executable.parent().unwrap().join(
            "../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
        );
        let development=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.cache/cef-native/ReflexionOS Studio Dev.app/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework");
        let path = if bundled.exists() {
            bundled
        } else if cfg!(debug_assertions) && development.exists() {
            development
        } else if cfg!(debug_assertions) {
            distribution()?
                .join("Chromium Embedded Framework.framework/Chromium Embedded Framework")
        } else {
            return Err("CEF framework unavailable".into());
        };
        let _ = FRAMEWORK.set(path.parent().unwrap().to_path_buf());
        let path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "invalid framework path")?;
        if unsafe { load_library(Some(&*path.as_ptr().cast())) } != 1 {
            return Err("CEF framework unavailable".into());
        }
        cocoa::setup();
    }
    let _ = api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    LOADED.store(true, Ordering::Release);
    Ok(())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    // Never call CEF's function table after a failed framework load.
    if !LOADED.load(Ordering::Acquire) {
        return Err("CEF framework unavailable".into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "CEF cache unavailable")?
        .join("cef");
    std::fs::create_dir_all(&cache).map_err(|_| "CEF cache unavailable")?;
    storage::collect(&cache)?;
    #[cfg(target_os = "windows")]
    if SANDBOX.load(Ordering::Acquire) == 0 {
        return Err("CEF sandbox bootstrap required".into());
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "CEF debugger unavailable")?;
    let port = listener
        .local_addr()
        .map_err(|_| "CEF debugger unavailable")?
        .port();
    drop(listener);
    let args = cef::args::Args::new();
    let settings = Settings {
        external_message_pump: 1,
        remote_debugging_port: port.into(),
        root_cache_path: CefString::from(cache.to_str().ok_or("invalid CEF cache path")?),
        ..Default::default()
    };
    #[cfg(target_os = "macos")]
    let settings = {
        let mut settings = settings;
        settings.framework_dir_path = CefString::from(
            FRAMEWORK
                .get()
                .ok_or("CEF framework unavailable")?
                .to_str()
                .ok_or("invalid CEF framework path")?,
        );
        let helper = helper_path()?;
        settings.browser_subprocess_path =
            CefString::from(helper.to_str().ok_or("invalid CEF helper path")?);
        settings
    };
    let mock_keychain = super::keychain::mock_enabled(app);
    let mut handler = application::BrowserApp::new(mock_keychain);
    #[cfg(target_os = "windows")]
    let sandbox = SANDBOX.load(Ordering::Acquire) as *mut u8;
    #[cfg(not(target_os = "windows"))]
    let sandbox = std::ptr::null_mut();
    if cef::initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut handler),
        sandbox,
    ) != 1
    {
        return Err("CEF initialization failed".into());
    }
    PORT.store(port, Ordering::Release);
    let _ = APP.set(app.clone());
    READY.store(true, Ordering::Release);
    pump::bind(app.clone());
    super::state::update(app, |state| {
        state.available = true;
        state.status = "idle".into();
        state.notice = None;
    });
    Ok(())
}
pub fn stopping() -> bool {
    lifecycle::closing()
}
pub fn dispatch(task: impl FnOnce() + Send + 'static) -> Result<(), String> {
    if !accepting() {
        return Err("browser_closed".into());
    }
    pump::defer(task);
    Ok(())
}
pub fn endpoint() -> String {
    format!("http://127.0.0.1:{}", PORT.load(Ordering::Acquire))
}
pub fn attach(app: &tauri::AppHandle) -> Result<(), String> {
    if !accepting() {
        return Err("browser_closed".into());
    }
    registry::attach(app, None)
}
pub fn control(app: &tauri::AppHandle, action: &super::state::Action) -> Result<(), String> {
    if !accepting() {
        return Err("browser_closed".into());
    }
    registry::control(app, action)
}
pub fn close_tab(id: u32) {
    registry::close(id);
}
pub fn dispose() {
    crate::browser::downloads::transfers::dispose();
    registry::dispose();
}
pub fn accepting() -> bool {
    ready() && !lifecycle::closing()
}
pub fn shutdown() {
    if let Some(app) = APP.get() {
        if lifecycle::parent_close_allowed() && app.get_webview_window("main").is_none() {
            lifecycle::window_closed(app.clone());
        } else {
            lifecycle::request(app.clone());
        }
    }
}
pub fn window_destroyed(app: tauri::AppHandle) {
    if lifecycle::parent_close_allowed() {
        lifecycle::window_closed(app);
    }
}
pub fn intercept_close() -> bool {
    if ready() && !lifecycle::parent_close_allowed() {
        shutdown();
        true
    } else {
        false
    }
}
pub fn created(id: u32) {
    lifecycle::created(id);
}
pub fn closed(app: tauri::AppHandle, id: u32) {
    lifecycle::closed(app, id);
}
pub fn stop() {
    if READY.swap(false, Ordering::AcqRel) {
        pump::stop();
        cef::shutdown();
    }
}

#[cfg(target_os = "macos")]
fn helper_path() -> Result<std::path::PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "executable unavailable")?;
    let relative = "reflexion-desktop Helper.app/Contents/MacOS/reflexion-desktop Helper";
    let bundled = executable
        .parent()
        .unwrap()
        .join("../Frameworks")
        .join(relative);
    if bundled.is_file() {
        return Ok(bundled);
    }
    let development = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.cache/cef-native/ReflexionOS Studio Dev.app/Contents/Frameworks")
        .join(relative);
    if cfg!(debug_assertions) && development.is_file() {
        return Ok(development);
    }
    Err("CEF helper unavailable; run pnpm prepare:cef".into())
}

pub fn reset_user(app: &tauri::AppHandle) {
    registry::reset_user(app);
}
pub fn release_agents(app: &tauri::AppHandle) {
    registry::close_agents(app);
}
