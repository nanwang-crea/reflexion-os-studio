use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapSnapshot {
    state: String,
    runtime_ready: bool,
    system_ready: bool,
    detail: Option<String>,
}

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
}

struct SupervisorState {
    snapshot: Mutex<BootstrapSnapshot>,
    runtime: Mutex<Option<SidecarProcess>>,
    system: Mutex<Option<SidecarProcess>>,
    stopping: AtomicBool,
    request_seq: AtomicU64,
}

fn initial_snapshot() -> BootstrapSnapshot {
    BootstrapSnapshot {
        state: "starting".to_string(),
        runtime_ready: false,
        system_ready: false,
        detail: None,
    }
}

fn update_state(
    app: &tauri::AppHandle,
    state: &SupervisorState,
    next: &str,
    detail: Option<String>,
) {
    // 失败详情此前只发前端，排障时终端里毫无线索；这里同步落一份到 stderr。
    match &detail {
        Some(text) => eprintln!("[host] state -> {next}: {text}"),
        None => eprintln!("[host] state -> {next}"),
    }
    let snapshot = {
        let Ok(mut snapshot) = state.snapshot.lock() else {
            return;
        };
        snapshot.state = next.to_string();
        snapshot.detail = detail;
        snapshot.clone()
    };
    let _ = app.emit("bootstrap:state", snapshot);
}

fn mark_ready(app: &tauri::AppHandle, state: &SupervisorState, name: &str) {
    let next = {
        let Ok(mut snapshot) = state.snapshot.lock() else {
            return;
        };
        if name == "runtime" {
            snapshot.runtime_ready = true;
        } else {
            snapshot.system_ready = true;
        }
        if snapshot.runtime_ready && snapshot.system_ready {
            "system-ready"
        } else if snapshot.runtime_ready {
            "runtime-ready"
        } else {
            "starting"
        }
    };
    update_state(app, state, next, None);
}

fn observe_stdout(
    app: tauri::AppHandle,
    state: Arc<SupervisorState>,
    name: &'static str,
    stdout: impl std::io::Read + Send + 'static,
) {
    std::thread::spawn(move || {
        let ready_method = format!("{name}.ready");
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                update_state(
                    &app,
                    &state,
                    "error",
                    Some(format!("{name} protocol parse error")),
                );
                continue;
            };
            if message.get("method").and_then(Value::as_str) == Some(ready_method.as_str()) {
                mark_ready(&app, &state, name);
            }
            let _ = app.emit(
                "bootstrap:message",
                json!({ "name": name, "message": message }),
            );
        }
    });
}

fn observe_stderr(name: &'static str, stderr: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            eprint!("[{name}] {line}");
            line.clear();
        }
    });
}

fn monitor_exit(app: tauri::AppHandle, state: Arc<SupervisorState>, name: &'static str) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let lock = if name == "runtime" {
            state.runtime.lock()
        } else {
            state.system.lock()
        };
        let Ok(mut guard) = lock else { return };
        let Some(process) = guard.as_mut() else {
            return;
        };
        match process.child.try_wait() {
            Ok(Some(status)) => {
                let stopping = state.stopping.load(Ordering::SeqCst);
                drop(guard);
                if !stopping && !status.success() {
                    update_state(
                        &app,
                        &state,
                        "system-degraded",
                        Some(format!("{name} exited ({status})")),
                    );
                }
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
    });
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    state: Arc<SupervisorState>,
    name: &'static str,
    command: &Path,
    args: &[PathBuf],
    cwd: &Path,
) -> Result<(), String> {
    let mut child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{name} spawn failed: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{name} stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{name} stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{name} stderr unavailable"))?;
    observe_stdout(app.clone(), state.clone(), name, stdout);
    observe_stderr(name, stderr);
    monitor_exit(app.clone(), state.clone(), name);
    let slot = if name == "runtime" {
        &state.runtime
    } else {
        &state.system
    };
    *slot
        .lock()
        .map_err(|_| format!("{name} process lock poisoned"))? =
        Some(SidecarProcess { child, stdin });
    Ok(())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn start_sidecars(app: &tauri::AppHandle, state: Arc<SupervisorState>) {
    let root = repo_root();
    let runtime_entry = root
        .join("apps")
        .join("runtime")
        .join("dist")
        .join("index.js");
    if !runtime_entry.exists() {
        update_state(
            app,
            &state,
            "error",
            Some(format!(
                "Runtime entry not found: {}",
                runtime_entry.display()
            )),
        );
        return;
    }

    let node = PathBuf::from("node");
    if let Err(error) = spawn_sidecar(
        app,
        state.clone(),
        "runtime",
        &node,
        &[runtime_entry],
        &root,
    ) {
        update_state(app, &state, "error", Some(error));
    }

    let system = std::env::var_os("REFLEXION_SYSTEM_RUNTIME")
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            [
                "target/debug",
                "crates/target/debug",
                "target/release",
                "crates/target/release",
            ]
            .into_iter()
            .map(|dir| root.join(dir).join("reflexion-system-runtime"))
            .flat_map(|path| {
                let mut with_exe = path.clone().into_os_string();
                with_exe.push(".exe");
                [path, PathBuf::from(with_exe)]
            })
            .find(|path| path.exists())
        });
    let Some(system) = system else {
        update_state(
            app,
            &state,
            "system-degraded",
            Some("Rust System Runtime binary not found; tools unavailable".to_string()),
        );
        return;
    };
    if let Err(error) = spawn_sidecar(app, state.clone(), "system", &system, &[], &root) {
        update_state(app, &state, "error", Some(error));
    }
}

#[tauri::command]
fn bootstrap_get_state(
    state: tauri::State<'_, Arc<SupervisorState>>,
) -> Result<BootstrapSnapshot, String> {
    state
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "bootstrap state lock poisoned".to_string())
}

#[tauri::command]
fn bootstrap_ping(state: tauri::State<'_, Arc<SupervisorState>>) -> Result<bool, String> {
    let id = state.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let mut guard = state
        .system
        .lock()
        .map_err(|_| "system process lock poisoned".to_string())?;
    let Some(process) = guard.as_mut() else {
        return Ok(false);
    };
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": "system.ping" });
    writeln!(process.stdin, "{message}")
        .map(|_| true)
        .map_err(|error| error.to_string())
}

/// 前端访问 Runtime 的唯一通道：白名单方法 + 分配 JSON-RPC id。
/// 响应经 bootstrap:message 事件透传，由前端按 id 关联。
#[tauri::command]
fn runtime_request(
    state: tauri::State<'_, Arc<SupervisorState>>,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
    const RUNTIME_METHODS: [&str; 13] = [
        "runtime.get_status",
        "project.list",
        "project.create",
        "session.list",
        "session.create",
        "session.get",
        "message.send",
        "run.cancel",
        "run.retry",
        "provider.list",
        "provider.configure",
        "provider.delete",
        "provider.test",
    ];
    if !RUNTIME_METHODS.contains(&method.as_str()) {
        return Err(format!("method not allowed: {method}"));
    }
    // webview 可能早于 setup 完成 invoke；sidecar 尚未就绪时短暂等待而不是立刻失败。
    for _ in 0..20 {
        {
            let guard = state
                .runtime
                .lock()
                .map_err(|_| "runtime process lock poisoned".to_string())?;
            if guard.is_some() {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "runtime process lock poisoned".to_string())?;
    let Some(process) = guard.as_mut() else {
        return Err("runtime not available".to_string());
    };
    let id = state.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writeln!(process.stdin, "{message}").map_err(|error| error.to_string())?;
    Ok(id)
}

fn send_message(process: &mut SidecarProcess, id: u64, method: &str) {
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    let _ = writeln!(process.stdin, "{message}");
}

fn begin_shutdown(state: &SupervisorState) {
    if state.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut snapshot) = state.snapshot.lock() {
        snapshot.state = "stopping".to_string();
        snapshot.detail = None;
    }
    if let Ok(mut guard) = state.runtime.lock() {
        if let Some(process) = guard.as_mut() {
            send_message(process, 1, "runtime.shutdown");
        }
    }
    if let Ok(mut guard) = state.system.lock() {
        if let Some(process) = guard.as_mut() {
            send_message(process, 2, "system.shutdown");
        }
    }
}

fn kill_sidecars(state: &SupervisorState) {
    for lock in [&state.runtime, &state.system] {
        if let Ok(mut guard) = lock.lock() {
            if let Some(process) = guard.as_mut() {
                let _ = process.child.kill();
            }
        }
    }
}

pub fn run() {
    let state = Arc::new(SupervisorState {
        snapshot: Mutex::new(initial_snapshot()),
        runtime: Mutex::new(None),
        system: Mutex::new(None),
        stopping: AtomicBool::new(false),
        request_seq: AtomicU64::new(0),
    });
    let state_for_setup = state.clone();
    let state_for_window = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            bootstrap_get_state,
            bootstrap_ping,
            runtime_request
        ])
        .setup(move |app| {
            start_sidecars(app.handle(), state_for_setup.clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if state_for_window.stopping.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                begin_shutdown(&state_for_window);
                let state_for_exit = state_for_window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1000));
                    kill_sidecars(&state_for_exit);
                    std::process::exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ReflexionOS Studio")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit { .. }) {
                let managed = app_handle.state::<Arc<SupervisorState>>();
                begin_shutdown(managed.inner());
                kill_sidecars(managed.inner());
            }
        });
}
