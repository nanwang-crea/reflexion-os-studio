//! Tauri 宿主入口：窗口 + sidecar supervisor。
//! 进程监管见 supervisor.rs、路径解析见 sidecar_paths.rs、
//! 关停与信号见 shutdown.rs；本文件只做装配与 Tauri 命令注册。

mod browser;
mod host;
mod logging;
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
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, Arc<SupervisorState>>,
) -> Result<BootstrapSnapshot, String> {
    host::caller::trusted(&webview, &app, &["main"])?;
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "bootstrap state lock poisoned".to_string())
}

/// 前端访问 Runtime 的唯一通道：白名单方法校验 + supervisor 转发。
#[tauri::command]
fn runtime_request(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: State<'_, Arc<SupervisorState>>,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
    host::caller::trusted(&webview, &app, &["main"])?;
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .manage(browser::BrowserState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap_get_state,
            runtime_request,
            host::external::open_external,
            browser::commands::browser_open,
            browser::commands::browser_capabilities,
            browser::commands::browser_clear_data,
            browser::downloads::browser_downloads,
            browser::downloads::browser_download_action,
            browser::commands::browser_control,
            browser::import::browser_import,
            browser::import::browser_credentials,
            browser::import::browser_fill,
            browser::import::browser_password_manage,
            browser::import::browser_clear_credentials
        ])
        .setup(move |app| {
            match app.path().app_log_dir() {
                Ok(directory) => logging::init(directory),
                Err(error) => logging::write(&format!("[host] log directory unavailable: {error}")),
            }
            logging::write(&format!(
                "[host] ReflexionOS Studio {} ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            supervisor::start_sidecars(app.handle(), state_for_setup.clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ReflexionOS Studio")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // tauri-runtime-wry 在最后一个窗口销毁时立即触发 ExitRequested；
                    // 编排必须在此而非 Destroyed，否则 RunEvent::Exit 会在毫秒级
                    // SIGKILL sidecar 树，掐断基于协议的优雅关停（AGENTS §8）。
                    api.prevent_exit();
                    if let Some(state) = app_handle.try_state::<Arc<SupervisorState>>() {
                        if !state.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                            shutdown::begin_shutdown(state.inner());
                            let handle = app_handle.clone();
                            std::thread::spawn(move || {
                                // 宽限须覆盖 TS 的协议关停宽限（2s），否则优雅关停被掐断。
                                std::thread::sleep(Duration::from_millis(3000));
                                if let Some(state) = handle.try_state::<Arc<SupervisorState>>() {
                                    shutdown::kill_runtime_tree(state.inner());
                                }
                                std::process::exit(0);
                            });
                        }
                    }
                }
                tauri::RunEvent::Exit { .. } => {
                    if let Some(state) = app_handle.try_state::<Arc<SupervisorState>>() {
                        if !state
                            .stopping
                            .swap(true, std::sync::atomic::Ordering::SeqCst)
                        {
                            shutdown::begin_shutdown(state.inner());
                            shutdown::kill_runtime_tree(state.inner());
                        }
                    }
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label == "main" => {
                    browser::dispose();
                }
                _ => {}
            }
        });
}
