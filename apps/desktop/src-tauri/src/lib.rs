//! Tauri 宿主入口：窗口 + sidecar supervisor。
//! 进程监管见 supervisor.rs、路径解析见 sidecar_paths.rs、
//! 关停与信号见 shutdown.rs；本文件只做装配与 Tauri 命令注册。

mod orphan_cleanup;
mod shutdown;
mod sidecar_paths;
mod supervisor;

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, State};

use supervisor::{initial_snapshot, BootstrapSnapshot, RuntimeRestartState, SupervisorState};

include!(concat!(env!("OUT_DIR"), "/runtime_methods.rs"));

#[tauri::command]
fn bootstrap_get_state(
    state: State<'_, Arc<SupervisorState>>,
) -> Result<BootstrapSnapshot, String> {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "bootstrap state lock poisoned".to_string())
}

/// 外部 URL 安全打开：仅允许 https，经系统默认浏览器打开（三平台显式分支，
/// 与 WebView 内导航隔离，永不内嵌）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "invalid external URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("only valid https external URLs allowed".to_string());
    }
    let trimmed = parsed.as_str();
    let status =
        open_with_system_browser(trimmed).map_err(|error| format!("failed to open: {error}"))?;
    if !status.success() {
        return Err(format!("system browser exited with status {status}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("open").arg(url).status()
}

#[cfg(target_os = "windows")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .status()
}

#[cfg(target_os = "linux")]
fn open_with_system_browser(url: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("xdg-open").arg(url).status()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn open_with_system_browser(_url: &str) -> std::io::Result<std::process::ExitStatus> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ))
}

/// 前端访问 Runtime 的唯一通道：白名单方法校验 + supervisor 转发。
#[tauri::command]
fn runtime_request(
    state: State<'_, Arc<SupervisorState>>,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
    if !RUNTIME_METHODS.contains(&method.as_str()) {
        return Err(format!("method not allowed: {method}"));
    }
    supervisor::runtime_request_impl(&state, method, params)
}

pub fn run() {
    shutdown::install_terminate_signal_handler();
    let state = Arc::new(SupervisorState {
        snapshot: Mutex::new(initial_snapshot()),
        runtime: Mutex::new(None),
        stopping: AtomicBool::new(false),
        request_seq: AtomicU64::new(0),
        restart: Mutex::new(RuntimeRestartState { count: 0 }),
    });
    let state_for_setup = state.clone();
    let state_for_window = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            bootstrap_get_state,
            runtime_request,
            open_external
        ])
        .setup(move |app| {
            supervisor::start_sidecars(app.handle(), state_for_setup.clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if state_for_window
                    .stopping
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    return;
                }
                api.prevent_close();
                shutdown::begin_shutdown(&state_for_window);
                let state_for_exit = state_for_window.clone();
                std::thread::spawn(move || {
                    // 宽限须覆盖 TS 的 Rust 协议关停宽限（2s），否则优雅关停被掐断。
                    std::thread::sleep(Duration::from_millis(3000));
                    shutdown::kill_runtime_tree(&state_for_exit);
                    std::process::exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ReflexionOS Studio")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit { .. }) {
                let managed = app_handle.state::<Arc<SupervisorState>>();
                shutdown::begin_shutdown(managed.inner());
                shutdown::kill_runtime_tree(managed.inner());
            }
        });
}
