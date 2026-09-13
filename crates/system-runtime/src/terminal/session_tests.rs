//! session.rs 的真实 PTY 集成测试（从 session.rs 拆出以维持本体单一职责；
//! 测试围绕 spawn/attach/close 时序，与本体同量级）。

use super::*;

fn pgrep_hits(pattern: &str) -> bool {
    std::process::Command::new("pgrep")
        .args(["-f", pattern])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn echo_roundtrip_over_real_pty() {
    let session = spawn("itest".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session
        .write_input(b"echo TERMINAL_OK_$((1+2))\r\n")
        .expect("write");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while session.output_seq.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(session.output_seq.load(Ordering::SeqCst) > 0);
    session.close();
}

#[test]
fn shell_exit_emits_no_panic_and_close_is_safe_after() {
    let session = spawn("itest2".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session.write_input(b"exit\r\n").expect("write");
    std::thread::sleep(std::time::Duration::from_millis(500));
    session.close(); // close 在已退出进程上不得 panic（幂等回收）
}

/// resize 走 master.ioctl；会话存活时必须成功。
#[test]
fn resize_on_live_session_succeeds() {
    let session = spawn("itest3".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session.resize(30, 100).expect("resize");
    session.close();
}

/// W2-2（真实 PTY）：attach 前输出只进缓冲、不对外发；attach 必须报告
/// 可补放的字节数（≥ echo 命令回显长度），且 output_seq 照常递增——
/// 「已编号」与「已交付」解耦的最小实证。
#[test]
fn pre_attach_buffer_then_replay() {
    let session = spawn("itest4".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session
        .write_input(b"echo HELD_ONELINE\r\n")
        .expect("write");
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        session.output_seq.load(Ordering::SeqCst) > 0,
        "未 attach 也必须完成编号入队"
    );
    let replayed = session.attach("tester");
    assert!(
        replayed >= 10,
        "attach 前缓冲的字节必须计入 replayedBytes，实得 {replayed}"
    );
    // 二次 attach 幂等：允许、更新消费者并重新快照，不产生第二个流。
    session.attach("tester2");
    session.close();
}

/// W2-3：无视 SIGHUP 的 shell 必须在升级时限内被收割。
/// `set +m` 关闭作业控制，让 sleep 留在 shell 的进程组里（组 SIGKILL
/// 直达；已实测 pgid 归并）；用唯一睡眠时长 421 圈定本测试的后代。
/// CloseGuard 保证断言失败也回收——trap-HUP 孤儿若不收割会跨 run 污染
/// pgrep 断言（首轮失败即为此教训）。
#[test]
fn trapped_hup_shell_is_killed_within_deadline() {
    struct CloseGuard<'a>(&'a TerminalSession);
    impl Drop for CloseGuard<'_> {
        fn drop(&mut self) {
            self.0.close();
        }
    }
    let session = spawn("itest5".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    let guard = CloseGuard(&session);
    session
        .write_input(b"set +m; trap '' HUP; sleep 421\r")
        .expect("write");
    // 前置条件轮询（并行测试负载下 shell 启动耗时不定）：sleep 出现即
    // trap 已生效（同一命令列表内 trap 先于 sleep 执行）。
    let started_deadline = Instant::now() + Duration::from_secs(5);
    while !pgrep_hits("sleep 421") && Instant::now() < started_deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(pgrep_hits("sleep 421"), "前置条件：sleep 421 必须在跑");
    let started = Instant::now();
    session.close();
    let close_elapsed = started.elapsed();
    assert!(
        close_elapsed < Duration::from_millis(1_500),
        "trap HUP 下 close 必须靠 SIGKILL 升级收敛，实耗 {close_elapsed:?}"
    );
    // 组 SIGKILL 覆盖 shell 与同组 sleep；给内核兜底留 2s 轮询窗口。
    let deadline = Instant::now() + Duration::from_secs(2);
    while pgrep_hits("sleep 421") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(guard);
    assert!(!pgrep_hits("sleep 421"), "close 后 sleep 421 不得残留");
}
