//! 启动时孤儿 sidecar 清理。
//!
//! 宿主被 SIGKILL/崩溃/断电时，TERM/INT handler 与退出收割路径都执行不到，
//! TS Runtime 及其子进程（Rust System Runtime、MCP server）会以 PPID=1 孤儿
//! 形态残留，持有 SQLite 数据库锁，导致下次启动的 Runtime 卡死在启动早期。
//!
//! 清理策略（精确匹配自家孤儿）：
//! 1. candidate：命令行包含自家 marker（开发态=编译期仓库路径；打包态=本安装
//!    的 resource_dir）。不同安装位置/开发与打包实例互不干扰。
//! 2. orphan：父进程已死亡。POSIX 上表现为被收养（PPID==1）；Windows 上父
//!    PID 保留但进程不在表中。父进程存活（含 PID 复用误判）时跳过——漏杀
//!    无害，下次启动再清；误杀活实例的 sidecar 有害，故宁漏勿误。
//! 3. 收割：按进程组/进程树整棵带走（覆盖 marker 匹配不到的 MCP 子进程）。

use sysinfo::{Pid, System};

/// 纯函数：命令行（join 后）是否包含任一 marker。空 marker 忽略。
fn matches_marker(cmd_joined: &str, markers: &[String]) -> bool {
    markers
        .iter()
        .any(|marker| !marker.is_empty() && cmd_joined.contains(marker.as_str()))
}

/// 纯函数：孤儿判定。
/// `parent` 为父 PID（sysinfo 记录值），`parent_alive` 为该 PID 是否在进程表中。
/// `self_pid` 与 `pid` 相等时永远返回 false（防止自杀）。
fn is_orphan(parent: Option<u32>, parent_alive: bool, self_pid: u32, pid: u32) -> bool {
    if pid == self_pid {
        return false;
    }
    match parent {
        // POSIX 收养（launchd/init）→ 父必死。
        Some(1) => true,
        // 父 PID 有记录但不在表中 → 父已死（Windows 孤儿形态；PID 复用时
        // parent_alive 误为 true，漏杀，方向安全）。
        Some(_) => !parent_alive,
        // 父信息不可得：candidate 已被 marker 收窄到自家家族，按孤儿处理。
        None => true,
    }
}

/// 单进程收割：按进程组/进程树整棵终止。
#[cfg(unix)]
fn kill_tree(pid: u32) -> bool {
    unsafe {
        // 防御：绝不在自己的进程组里开火（清理先于自家 sidecar 启动，正常
        // 不会命中；纯兜底）。
        if libc::getpgid(pid as libc::pid_t) == libc::getpgrp() {
            return false;
        }
        // sidecar 根是组 leader（spawn 时 process_group(0)），负号 PGID 覆盖
        // 整组（含 Rust System Runtime 与 MCP 子进程）。组已消散则退回单杀，
        // 兜住"node 已死、仅剩 Rust 孤儿"的形态。
        let pgid = libc::getpgid(pid as libc::pid_t);
        let target = if pgid > 0 {
            -pgid
        } else {
            -(pid as libc::pid_t)
        };
        libc::kill(target, libc::SIGKILL) == 0
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) -> bool {
    // taskkill /T 按父子关系终止整棵树，/F 强制；与 kill_runtime_tree 同款。
    // 已知局限：node 已死、仅剩 Rust 孤儿时，其 MCP 子进程不被 /T 覆盖，可能
    // 残留（POSIX 经进程组无此问题）；该形态罕见，残留项下次整树清理再收。
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn kill_tree(_pid: u32) -> bool {
    false
}

/// 清理命令行命中 `markers` 且父进程已死亡的孤儿进程，返回成功收割的 PID。
/// 枚举/权限/单点失败均不影响调用方启动流程。
pub fn cleanup_orphans(markers: &[String]) -> Vec<u32> {
    let effective: Vec<String> = markers
        .iter()
        .filter(|marker| !marker.trim().is_empty())
        .cloned()
        .collect();
    if effective.is_empty() {
        return Vec::new();
    }
    let self_pid = std::process::id();
    // 宿主自身命令行（尤其打包态 exe 与 resource_dir 同目录、AppImage 挂载点
    // 即 resource_dir）可能命中 marker，且从 Finder/桌面启动时 PPID==1——按
    // 宿主 exe 文件名排除，防止第二个实例误杀第一个活实例的宿主。
    let host_exe = std::env::current_exe().ok().and_then(|exe| {
        exe.file_name()
            .map(|name| name.to_string_lossy().to_string())
    });
    // new_all() 构造时已完成全量刷新，后续只读访问。
    let system = System::new_all();

    let candidates: Vec<(u32, Option<u32>)> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let cmd_joined = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(host_exe) = &host_exe {
                if cmd_joined.contains(host_exe.as_str()) {
                    return None;
                }
            }
            if matches_marker(&cmd_joined, &effective) {
                Some((pid.as_u32(), process.parent().map(|p| p.as_u32())))
            } else {
                None
            }
        })
        .collect();

    let mut killed = Vec::new();
    for (pid, parent) in candidates {
        let parent_alive = parent
            .map(|parent_pid| system.processes().contains_key(&Pid::from_u32(parent_pid)))
            .unwrap_or(false);
        if !is_orphan(parent, parent_alive, self_pid, pid) {
            continue;
        }
        if kill_tree(pid) {
            killed.push(pid);
        }
    }
    killed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_matches_only_marked_cmdlines() {
        let markers = vec!["/repo".to_string()];
        assert!(matches_marker(
            "node --disable-warning=ExperimentalWarning /repo/apps/runtime/dist/index.js",
            &markers
        ));
        assert!(matches_marker(
            "/repo/crates/target/debug/reflexion-system-runtime",
            &markers
        ));
        assert!(!matches_marker("node /other/app/index.js", &markers));
        assert!(!matches_marker("", &markers));
    }

    #[test]
    fn empty_markers_never_match() {
        assert!(!matches_marker("node /repo/index.js", &[]));
        assert!(!matches_marker("node /repo/index.js", &[String::new()]));
    }

    #[test]
    fn orphan_rules() {
        // 永不自杀。
        assert!(!is_orphan(Some(1), true, 100, 100));
        // POSIX 收养（PPID==1）→ 孤儿。
        assert!(is_orphan(Some(1), true, 100, 200));
        // 父 PID 有记录但已死 → 孤儿（Windows 形态）。
        assert!(is_orphan(Some(55), false, 100, 200));
        // 父存活 → 非孤儿（多实例并发安全的关键）。
        assert!(!is_orphan(Some(55), true, 100, 200));
        // 父信息不可得 → 按孤儿处理（marker 已收窄到自家家族）。
        assert!(is_orphan(None, false, 100, 200));
    }
}
