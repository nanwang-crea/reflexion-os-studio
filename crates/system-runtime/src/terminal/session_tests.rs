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
/// M-4：有界轮询（≤5 s）替换固定 sleep——≥2 帧编号且相邻采样稳定
/// （fetch_add 先于 push，稳定一轮说明在途帧已入队）再 attach。
#[test]
fn pre_attach_buffer_then_replay() {
    let session = spawn("itest4".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session
        .write_input(b"echo HELD_ONELINE\r\n")
        .expect("write");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last_seq = 0u64;
    loop {
        let seq = session.output_seq.load(Ordering::SeqCst);
        if seq >= 2 && seq == last_seq {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "超时：未 attach 的编号入队未稳定完成，seq={seq}"
        );
        last_seq = seq;
        std::thread::sleep(Duration::from_millis(50));
    }
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

/// W4-2b：close 之后 write_input 必须以 terminal_closed **快速**失败——
/// 输入走有界队列 + 专用写线程，enqueue 不再触碰 master fd，也就不会
/// 继承阻塞写的不确定性（旧实现在此处是同步 write_all，行为随内核队列状态漂移）。
#[test]
fn write_after_close_is_terminal_closed_fast() {
    let session = spawn("itest6".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session.write_input(b"echo INPUT_Q_OK\r").expect("write");
    session.close();
    let started = Instant::now();
    let error = session.write_input(b"x").expect_err("close 后输入必须被拒");
    assert!(
        error.contains("terminal_closed"),
        "close 后错误须含 terminal_closed，实得 {error}"
    );
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "enqueue 拒绝不得阻塞：{:?}",
        started.elapsed()
    );
}

/// W4-2b：shell 退出（slave 关闭 → master write EIO）后，写线程把错误
/// 落进 closed 标志；之后的 write_input 以 terminal_closed 失败。错误只在
/// 写线程真正撞上时可见（enqueue 本身即时返回），因此用轮询而非单次断言。
#[test]
fn input_to_dead_shell_surfaces_terminal_closed() {
    let session = spawn("itest7".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    session.write_input(b"exit\r\n").expect("write");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match session.write_input(b"x") {
            Err(error) => {
                assert!(
                    error.contains("terminal_closed"),
                    "死壳输入须报 terminal_closed，实得 {error}"
                );
                break;
            }
            Ok(()) => {
                assert!(
                    Instant::now() < deadline,
                    "exit 后 5s 内写线程必须撞上 EIO 并置 terminal_closed"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    session.close();
}

/// W4-2b（真实 PTY，spike §9.1 注 2/注 6 场景）：前台 `yes` 洪泛期间灌
/// 40×8 KiB 输入——**每次调用必须即时返回**（Ok 入队或 Err(input_backpressure)，
/// 主循环语义），绝不允许阻塞在 master write 上；close 必须能在写线程
/// 卡死于 ldisc 时仍收敛（kill → slave 关闭 → 阻塞写 EIO 解卡）。
/// 「洪泛时必然溢出」依赖 macOS 内核输入队列在 ~1 KiB 未读输入后阻塞
/// master write 的实测行为，但为避免跨机时序抖动，接受度判据与 spike #14
/// 一致：溢出（≥1 次拒绝）或全部入队都算通过，唯一硬门槛是不阻塞 + close 不卡。
#[test]
fn busy_shell_input_enqueue_never_blocks_and_close_unwinds() {
    let session = spawn("itest8".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    let guard = CloseGuard(&session);
    // attach + 持续 ack：打开窗口让洪泛真的流起来（否则 256 KiB 窗口满后
    // producer 停读，seq 卡在 ~17 帧，无法与提示符重绘区分）。
    session.attach("itest8-test");
    session.write_input(b"yes\r").expect("start flood");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        session.ack(u64::MAX);
        let seq = session.output_seq.load(Ordering::SeqCst);
        if seq >= 200 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "yes 洪泛输出未起（疑似假阳性），seq={seq}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // 内核输入队列只累积极短完整行（cooked canq：>255B 单行被静默丢弃、
    // 不产生背压；~1 KiB 未读行积压后 master write 阻塞——spike §9.1 注 2
    // 实测即 60+ 行 ≈900B 的碎行输入）。8 KiB 有效载荷必须由短行构成，
    // 否则测不到阻塞条件；且**恒 ≤MAX_INPUT_BATCH**（终审 #3 入队前硬校验，
    // 旧构造末尾可越过 8192 被拒——那不是本测试要测的路径）。
    let mut payload = Vec::with_capacity(MAX_INPUT_BATCH);
    while payload.len() + 252 <= MAX_INPUT_BATCH {
        payload.extend_from_slice(&[b'x'; 250]);
        payload.push(b'\r');
        payload.push(b'\n');
    }
    let started = Instant::now();
    let mut rejected = 0;
    for _ in 0..40 {
        match session.write_input(&payload) {
            Ok(()) => {}
            Err(error) => {
                assert!(
                    error.contains("input_backpressure"),
                    "队列溢出须报 input_backpressure，实得 {error}"
                );
                rejected += 1;
            }
        }
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "40 次 enqueue 出现阻塞（写线程未与主循环解耦）：{elapsed:?}"
    );
    eprintln!("itest8: busy-shell 40x8KiB enqueue {elapsed:?}, rejected={rejected}/40");
    let close_started = Instant::now();
    drop(guard); // close：SIGKILL 杀 yes+shell → 卡死的 master write 以 EIO 解卡
    assert!(
        close_started.elapsed() < Duration::from_secs(2),
        "close 被卡死的输入写线程拖累：{:?}",
        close_started.elapsed()
    );
}

/// 跨测试复用的回收守卫（断言失败也不留孤儿 shell）。
struct CloseGuard<'a>(&'a TerminalSession);
impl Drop for CloseGuard<'_> {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// 终审 #3（spec §6）：>8 KiB 输入批次在**入队前**即时拒绝（invalid_request
/// 语义串），不触队列、不触 master fd；恰 8 KiB 是合法边界必须放行。
/// 拒绝路径同步返回，无时序抖动；8 KiB 合法批为无换行单行，cooked 模式
/// 静默丢弃（spike §9.1 注 2），不会给 shell 制造积压。
#[test]
fn oversized_input_batch_is_rejected_before_enqueue() {
    let session = spawn("itest9".to_string(), 7, "/tmp", 24, 80).expect("spawn");
    let _guard = CloseGuard(&session);
    session
        .write_input(&vec![b'a'; MAX_INPUT_BATCH])
        .expect("恰好 8 KiB 必须合法");
    let started = Instant::now();
    let error = session
        .write_input(&vec![b'a'; MAX_INPUT_BATCH + 1])
        .expect_err("超限必须拒绝");
    assert!(
        error.contains("input batch too large"),
        "超限错误须含 input batch too large，实得 {error}"
    );
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "入队前拒绝必须即时：{:?}",
        started.elapsed()
    );
}
