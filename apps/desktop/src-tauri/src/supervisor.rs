//! sidecar 监管：TS Runtime 进程生成、stdout/stderr 观察、exit 监控与有限重启。
//! 协议语义见 packages/contracts；宿主只做进程与状态投影，不实现业务逻辑。

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

use super::sidecar_paths::RuntimeLaunchConfig;

#[cfg(unix)]
pub(super) static TERMINATED_RUNTIME_PID: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BootstrapSnapshot {
    pub state: String,
    pub runtime_ready: bool,
    pub system_ready: bool,
    pub detail: Option<String>,
}

pub(super) struct SidecarProcess {
    pub child: Child,
    pub stdin: ChildStdin,
}

pub(super) struct SupervisorState {
    pub snapshot: Mutex<BootstrapSnapshot>,
    pub runtime: Mutex<Option<SidecarProcess>>,
    pub stopping: AtomicBool,
    pub request_seq: AtomicU64,
    pub restart: Mutex<RuntimeRestartState>,
}

/// TS Runtime 崩溃重启记账：有限次数 + 退避，耗尽后保持不可用直到应用重启，
/// 与 Rust System Runtime（apps/runtime/src/system.ts）的自愈语义对齐。
pub(super) struct RuntimeRestartState {
    pub count: u32,
}

/// TS Runtime 崩溃重启预算：I/O 或瞬时故障可自愈，但避免连续崩溃打满 CPU/内存。
const MAX_RUNTIME_RESTARTS: u32 = 3;
const RUNTIME_RESTART_BACKOFF_MS: [u64; 3] = [500, 1_000, 2_000];

pub(super) fn initial_snapshot() -> BootstrapSnapshot {
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

pub(super) fn update_state(
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
                // 重启成功后清零预算：历史崩溃不再累计，避免后续无谓降级。
                if let Ok(mut restart) = state.restart.lock() {
                    restart.count = 0;
                }
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

fn monitor_exit(app: tauri::AppHandle, state: Arc<SupervisorState>, cfg: Arc<RuntimeLaunchConfig>) {
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
                // 进程已退出：清空槽位并置 runtime_ready=false，避免死进程残留在
                // state.runtime / runtime_ready 导致 UI 误报“Chat 可用”。
                *guard = None;
                drop(guard);
                if stopping || status.success() {
                    return;
                }
                let detail = format!("runtime exited ({status})");
                let next = {
                    let Ok(mut snapshot) = state.snapshot.lock() else {
                        return;
                    };
                    snapshot.runtime_ready = false;
                    derive_state(snapshot.runtime_ready, snapshot.system_ready)
                };
                update_state(&app, &state, next, Some(detail));
                // 有限重启 + 退避：一次性故障（如瞬时 OOM）可自愈，连续崩溃则停手。
                let delay_ms = {
                    let Ok(mut restart) = state.restart.lock() else {
                        return;
                    };
                    if restart.count >= MAX_RUNTIME_RESTARTS {
                        eprintln!("[host] runtime restart budget exhausted; staying down");
                        return;
                    }
                    let backoff = RUNTIME_RESTART_BACKOFF_MS[restart.count as usize];
                    restart.count += 1;
                    backoff
                };
                eprintln!("[host] runtime exited, restarting in {delay_ms}ms");
                let state_for_restart = state.clone();
                let cfg_for_restart = cfg.clone();
                let app_for_restart = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    if state_for_restart.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    launch_runtime(&app_for_restart, state_for_restart, cfg_for_restart);
                });
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
    command: &std::path::Path,
    args: &[PathBuf],
    cwd: &std::path::Path,
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
    Ok(SidecarProcess { child, stdin })
}

/// 拉起一次 TS Runtime，并为其挂单代 exit 监控（意外退出时清槽位 + 有限重启）。
pub(super) fn launch_runtime(
    app: &tauri::AppHandle,
    state: Arc<SupervisorState>,
    cfg: Arc<RuntimeLaunchConfig>,
) {
    let envs: Vec<(&str, &str)> = cfg
        .envs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    match spawn_sidecar(app, state.clone(), &cfg.node, &cfg.args, &cfg.cwd, &envs) {
        Ok(process) => {
            #[cfg(unix)]
            TERMINATED_RUNTIME_PID.store(process.child.id() as usize, Ordering::SeqCst);
            if let Ok(mut guard) = state.runtime.lock() {
                *guard = Some(process);
            }
            monitor_exit(app.clone(), state.clone(), cfg.clone());
        }
        Err(error) => {
            let next = {
                let Ok(mut snapshot) = state.snapshot.lock() else {
                    return;
                };
                snapshot.runtime_ready = false;
                derive_state(snapshot.runtime_ready, snapshot.system_ready)
            };
            update_state(app, &state, next, Some(error));
        }
    }
}

pub(super) fn start_sidecars(app: &tauri::AppHandle, state: Arc<SupervisorState>) {
    use super::sidecar_paths::{orphan_cleanup_markers, repo_root, resolve_runtime_launch_config};
    let root = repo_root();
    // 安装包内资源目录：打包态存在并作为 sidecar 首要来源；开发态缺失走仓库回退。
    // debug 构建（pnpm dev / cargo run）一律视为开发态：忽略打包资源，
    // 回退仓库 dist 与 PATH node。否则上次打包遗留的过期 pkg 快照
    // （与最新契约不同步）会在开发态被优先加载，造成前后端协议错位。
    let resources = if cfg!(debug_assertions) {
        None
    } else {
        app.path().resource_dir().ok()
    };
    // 先清掉上次宿主异常死亡残留的孤儿 sidecar（持 SQLite 锁会卡死本次启动），
    // 再拉起自家 sidecar；顺序不可颠倒。
    let killed =
        crate::orphan_cleanup::cleanup_orphans(&orphan_cleanup_markers(resources.as_deref()));
    if killed.is_empty() {
        eprintln!("[host] orphan cleanup: nothing to kill");
    } else {
        eprintln!(
            "[host] orphan cleanup: killed {} process(es): {killed:?}",
            killed.len()
        );
    }
    let Some(cfg) = resolve_runtime_launch_config(resources.as_deref(), &root) else {
        update_state(
            app,
            &state,
            "error",
            Some("Runtime entry not found".to_string()),
        );
        return;
    };
    if cfg.envs.is_empty() {
        update_state(
            app,
            &state,
            "system-degraded",
            Some("Rust System Runtime binary not found; tools unavailable".to_string()),
        );
    }
    launch_runtime(app, state, Arc::new(cfg));
}

/// 前端访问 Runtime 的唯一通道：白名单方法 + 分配 JSON-RPC id。
/// 响应经 bootstrap:message 事件透传，由前端按 id 关联。
pub(super) fn runtime_request_impl(
    state: &SupervisorState,
    method: String,
    params: serde_json::Value,
) -> Result<u64, String> {
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
