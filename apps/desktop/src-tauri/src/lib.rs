use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(unix)]
static TERMINATED_RUNTIME_PID: AtomicUsize = AtomicUsize::new(0);

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

/// 依据 runtime_ready / system_ready 重算状态标签。
/// system_ready 由 TS 的 runtime.status 事件第一手上报，宿主只做投影。
fn derive_state(runtime_ready: bool, system_ready: bool) -> &'static str {
    if runtime_ready && system_ready {
        "system-ready"
    } else if runtime_ready {
        "runtime-ready"
    } else {
        "starting"
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
            let method = message.get("method").and_then(Value::as_str);
            if method == Some(ready_method.as_str()) {
                let next = {
                    let Ok(mut snapshot) = state.snapshot.lock() else {
                        continue;
                    };
                    snapshot.runtime_ready = true;
                    derive_state(snapshot.runtime_ready, snapshot.system_ready)
                };
                update_state(&app, &state, next, None);
            }
            if method == Some("runtime.status") {
                // 方案 A：系统可用性由 TS 第一手上报（runtime.status 事件），
                // 宿主只把它投影进 bootstrap 快照，不与 Rust 直接通信。
                let system_available = message
                    .get("params")
                    .and_then(|params| params.get("status"))
                    .and_then(|status| status.get("systemAvailable"))
                    .and_then(Value::as_bool);
                if let Some(system_available) = system_available {
                    let next = {
                        let Ok(mut snapshot) = state.snapshot.lock() else {
                            continue;
                        };
                        snapshot.system_ready = system_available;
                        derive_state(snapshot.runtime_ready, snapshot.system_ready)
                    };
                    update_state(&app, &state, next, None);
                }
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

fn monitor_exit(app: tauri::AppHandle, state: Arc<SupervisorState>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Ok(mut guard) = state.runtime.lock() else {
            return;
        };
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
                        Some(format!("runtime exited ({status})")),
                    );
                }
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
    });
}

/// POSIX：TS 进入独立进程组；Windows：交给关闭阶段的 taskkill 树杀。
fn spawn_sidecar(
    app: &tauri::AppHandle,
    state: Arc<SupervisorState>,
    command: &Path,
    args: &[PathBuf],
    cwd: &Path,
    envs: &[(&str, &str)],
) -> Result<SidecarProcess, String> {
    let mut command = Command::new(command);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        // 独立进程组：宿主兜底收割时 kill(-pgid) 连 TS 的子进程（Rust）一起带走。
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("runtime spawn failed: {error}"))?;
    // 管道获取失败时必须杀掉已 spawn 的子进程，否则泄漏一个无监管的 node。
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("runtime stdin unavailable".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("runtime stdout unavailable".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        return Err("runtime stderr unavailable".to_string());
    };
    observe_stdout(app.clone(), state.clone(), "runtime", stdout);
    observe_stderr("runtime", stderr);
    monitor_exit(app.clone(), state);
    Ok(SidecarProcess { child, stdin })
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

/// Rust System Runtime 二进制解析（宿主只负责找到路径并交给 TS，
/// spawn/监管由 TS 承担）：env 覆盖优先，其次仓库相对路径（带 .exe 变体）。
fn resolve_system_runtime(root: &Path) -> Option<PathBuf> {
    std::env::var_os("REFLEXION_SYSTEM_RUNTIME")
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
        })
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

    // Rust 二进制路径经环境变量交接给 TS；找不到也照常启动（TS 会按
    // runtime.status 上报 degraded，工具不可用但不阻塞 Chat）。
    let system_binary_env: Option<(String, String)> = resolve_system_runtime(&root).map(|path| {
        (
            "REFLEXION_SYSTEM_RUNTIME_BIN".to_string(),
            path.display().to_string(),
        )
    });
    let envs: Vec<(&str, &str)> = system_binary_env
        .as_ref()
        .map(|(key, value)| vec![(key.as_str(), value.as_str())])
        .unwrap_or_default();

    let node = PathBuf::from("node");
    match spawn_sidecar(app, state.clone(), &node, &[runtime_entry], &root, &envs) {
        Ok(process) => {
            #[cfg(unix)]
            TERMINATED_RUNTIME_PID.store(process.child.id() as usize, Ordering::SeqCst);
            if let Ok(mut guard) = state.runtime.lock() {
                *guard = Some(process);
            }
        }
        Err(error) => update_state(app, &state, "error", Some(error)),
    }
    if system_binary_env.is_none() {
        update_state(
            app,
            &state,
            "system-degraded",
            Some("Rust System Runtime binary not found; tools unavailable".to_string()),
        );
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

/// 前端访问 Runtime 的唯一通道：白名单方法 + 分配 JSON-RPC id。
/// 响应经 bootstrap:message 事件透传，由前端按 id 关联。
#[tauri::command]
fn runtime_request(
    state: tauri::State<'_, Arc<SupervisorState>>,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
    const RUNTIME_METHODS: [&str; 27] = [
        "runtime.get_status",
        "system.ping",
        "project.list",
        "project.create",
        "project.delete",
        "session.list",
        "session.create",
        "session.rename",
        "session.delete",
        "session.get",
        "message.send",
        "run.cancel",
        "run.retry",
        "approval.resolve",
        "provider.list",
        "provider.configure",
        "provider.delete",
        "provider.test",
        "memory.list",
        "memory.update",
        "memory.delete",
        "skill.list",
        "workspace.index.start",
        "workspace.index.cancel",
        "workspace.index.status",
        "workspace.list_dir",
        "workspace.read_file",
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

fn begin_shutdown(state: &SupervisorState) {
    if state.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut snapshot) = state.snapshot.lock() {
        snapshot.state = "stopping".to_string();
        snapshot.detail = None;
    }
    // Rust 的协议关停由 TS 负责（runtime.shutdown → system.shutdown → 退出）；
    // 宿主只等待，超时后 kill_runtime_tree 兜底收割整棵树。
    if let Ok(mut guard) = state.runtime.lock() {
        if let Some(process) = guard.as_mut() {
            let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "runtime.shutdown" });
            let _ = writeln!(process.stdin, "{message}");
        }
    }
}

/// 兜底收割：TS 及其整棵子进程树（含 TS spawn 的 Rust System Runtime）。
fn kill_runtime_tree(state: &SupervisorState) {
    let Ok(mut guard) = state.runtime.lock() else {
        return;
    };
    let Some(process) = guard.as_mut() else {
        return;
    };
    let pid = process.child.id();
    #[cfg(unix)]
    {
        // TS 在独立进程组（pgid == 其 pid），负号 PGID 信号覆盖整棵组。
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        // taskkill /T 按父子关系终止整棵树，/F 强制。
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = process.child.kill();
}

#[cfg(unix)]
extern "C" fn on_terminate_signal(_signal: libc::c_int) {
    // async-signal-safe：只做 kill(-pgid) 与 _exit，不触碰锁/堆。
    // 宿主被 TERM/INT 时 Tauri 不经过窗口关闭路径，必须在此收割 TS 进程组，
    // 否则 TS 及其 Rust 子进程全部孤儿化。优雅关停仍走 runtime.shutdown 协议。
    let pid = TERMINATED_RUNTIME_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    unsafe {
        libc::_exit(0);
    }
}

#[cfg(unix)]
fn install_terminate_signal_handler() {
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
    }
}

#[cfg(not(unix))]
fn install_terminate_signal_handler() {}

pub fn run() {
    install_terminate_signal_handler();
    let state = Arc::new(SupervisorState {
        snapshot: Mutex::new(initial_snapshot()),
        runtime: Mutex::new(None),
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
                    // 宽限须覆盖 TS 的 Rust 协议关停宽限（2s），否则优雅关停被掐断。
                    std::thread::sleep(Duration::from_millis(3000));
                    kill_runtime_tree(&state_for_exit);
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
                kill_runtime_tree(managed.inner());
            }
        });
}
