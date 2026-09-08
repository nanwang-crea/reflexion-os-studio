//! 优雅关停与兜底收割：协议关停（runtime.shutdown）→ 超时整树收割。
//! 信号只作兜底（POSIX）；Windows 无 SIGTERM，依赖协议关停 + taskkill 树杀。

#[cfg(windows)]
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

use serde_json::json;
use std::io::Write;

use super::supervisor::{SidecarProcess, SupervisorState};

pub(super) fn begin_shutdown(state: &SupervisorState) {
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
pub(super) fn kill_runtime_tree(state: &SupervisorState) {
    let Ok(mut guard) = state.runtime.lock() else {
        return;
    };
    let Some(process) = guard.as_mut() else {
        return;
    };
    kill_process_tree(process);
}

fn kill_process_tree(process: &mut SidecarProcess) {
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
    use std::sync::atomic::Ordering;
    // async-signal-safe：只做 kill(-pgid) 与 _exit，不触碰锁/堆。
    // 宿主被 TERM/INT 时 Tauri 不经过窗口关闭路径，必须在此收割 TS 进程组，
    // 否则 TS 及其 Rust 子进程全部孤儿化。优雅关停仍走 runtime.shutdown 协议。
    let pid = super::supervisor::TERMINATED_RUNTIME_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    unsafe {
        libc::_exit(0);
    }
}

pub(super) fn install_terminate_signal_handler() {
    #[cfg(unix)]
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
        // 终端关闭/挂断等场景同样会孤儿化 sidecar，与 TERM/INT 同路收割。
        libc::signal(
            libc::SIGHUP,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGQUIT,
            on_terminate_signal as *const () as libc::sighandler_t,
        );
    }
}
