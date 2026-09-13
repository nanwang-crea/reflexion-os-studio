//! 单个 PTY 会话（W2 硬化）：生产者线程 → 有界输出队列（output_queue）→
//! 唯一 sender 线程 → ≤16 KiB 帧 + 终端内 outputSeq + base64 通知输出；
//! attach 门控 + ack 窗口（W2-2）；SIGHUP→SIGKILL 时限升级回收（W2-3）。
//! 消费者代际与 16ms 合帧在 TS 侧，不在此文件。
//!
//! portable-pty 0.8.1 实测校准（预飞行核查，W1 沉淀）：
//! - `wait()` 返回 `ExitStatus`（`code: u32` + 私有 `signal: Option<String>`），
//!   不存在 `WaitStatus` 枚举；公开 API 无法读取信号名——被信号终止的进程
//!   统一报告 crate 映射后的退出码（通常为 1），如实透传，不伪造负数信号。
//! - `CommandBuilder` 没有 `term()` 方法，TERM 经 `env()` 显式注入。
//! - `Child::wait` 会在退出线程长时间持有 child 锁；`close()` 必须经
//!   `clone_killer()` 拿独立 killer 句柄发信号（库注释明示的用法），
//!   否则 kill 永远拿不到锁、close 挂死。轮询同理走 `try_lock` + `try_wait`；
//!   std::process::Child 对收割结果有缓存（1.98 实测），双线程先后
//!   wait 同一对象不会 ECHILD 竞态。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
#[cfg(unix)]
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;

use crate::protocol::emit;
use crate::terminal::output_queue::{chunk_frames, Frame, OutputQueue};
use crate::terminal::shell_command::default_shell_argv;

/// SIGHUP 后等待 shell 自行收敛的时限；超时即 SIGKILL 升级（W2-3）。
#[cfg(unix)]
const HUP_DEADLINE: Duration = Duration::from_millis(500);

pub struct TerminalSession {
    pub id: String,
    pub generation: u64,
    /// seq 源：仅生产者线程递增，帧在队列内编号连续；attach 门控解耦的是
    /// 「已编号」与「已发出」，service 的 json_meta 与消费端缺口检测都读它。
    pub output_seq: Arc<AtomicU64>,
    queue: Arc<OutputQueue>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// spawn 时的 PID 快照：SIGKILL 升级需按 pid 与其组发信号（W2-3）。
    #[cfg(unix)]
    child_pid: Option<u32>,
}

/// 单帧交付通知（帧已由生产者按 ≤16 KiB 切好）。
fn emit_frame(terminal_id: &str, generation: u64, seq: u64, bytes: &[u8]) {
    emit(json!({
        "jsonrpc": "2.0",
        "method": "terminal.output",
        "params": {
            "terminalId": terminal_id,
            "outputSeq": seq,
            "generation": generation,
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }));
}

fn emit_state(terminal_id: &str, generation: u64, status: &str, exit_code: Option<i64>) {
    emit(json!({
        "jsonrpc": "2.0",
        "method": "terminal.state",
        "params": {
            "terminalId": terminal_id,
            "generation": generation,
            "status": status,
            // Option 直出：None → null（尚未退出/未知），Some(n) → 数字。
            "exitCode": exit_code,
        }
    }));
}

pub fn spawn(
    terminal_id: String,
    generation: u64,
    cwd: &str,
    rows: u16,
    cols: u16,
) -> Result<Arc<TerminalSession>, String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("openpty failed: {error}"))?;
    let argv = default_shell_argv();
    let mut command = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        command.arg(arg);
    }
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("spawn failed: {error}"))?;
    // 父进程侧从属 fd 必须关闭，否则读线程永远等不到 EOF。
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone reader failed: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("take writer failed: {error}"))?;
    let killer = child.clone_killer();
    #[cfg(unix)]
    let child_pid = child.process_id();

    // spec §5「Rust 先建立有界输出缓冲，再启动 shell」：running 先于
    // 线程与任何输出（Task 10 评审修复：exited 永不在 running 之前送达）。
    let queue = Arc::new(OutputQueue::new());
    let session = Arc::new(TerminalSession {
        id: terminal_id.clone(),
        generation,
        output_seq: Arc::new(AtomicU64::new(0)),
        queue: queue.clone(),
        writer: Mutex::new(writer),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        killer: Mutex::new(killer),
        #[cfg(unix)]
        child_pid,
    });
    emit_state(&terminal_id, generation, "running", None);

    // 生产者线程（W1 读线程的职责演进）：只分帧、编号、入队；
    // 是否可交付/窗口是否有额度由队列裁决。EOF 后经 tail 通知退出线程。
    //
    // 关键教训（W2 首轮 spike 实锤的回归）：close 之后**读取与排空绝不能停**——
    // dying shell 的收尾写（ZLE teardown、job status）依赖 master 队列持续
    // 被消费；若 close 立刻停止 read()，队列填满后 shell 会永久卡在
    // 内核 exit 路径（ps 状态 `?Es`），waitpid 永不返回、close 死锁。
    // close 之后改为「读了就丢」：尾部丢失是 spec §6 的明示豁免，
    // 卡死则是事故。
    let produce_queue = queue.clone();
    let produce_seq = session.output_seq.clone();
    let (tail_tx, tail_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8 * 1024];
        loop {
            let n = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            for (_delta, chunk) in chunk_frames(&buffer[..n]) {
                let seq = produce_seq.fetch_add(1, Ordering::SeqCst);
                // 窗口满会在这里阻塞（暂停 PTY 读取、不丢字符流）；
                // close 后转丢弃模式（push 返回 false），继续排空到 EOF。
                if produce_queue.push(Frame {
                    seq,
                    bytes: chunk.to_vec(),
                }) {
                    continue;
                }
                break;
            }
        }
        let _ = tail_tx.send(());
    });

    // 唯一 sender：attach 且未关闭才交付；take_emit_batch 已把帧字节克隆出
    // 锁，emit（内部拿 STDOUT_LOCK）时不持队列锁——避免锁序嵌套。
    // 整批写出后才 mark_delivered（重入取批循环之前）：exit 线程的
    // wait_final_delivery 以「已写出」为判据，exited 严格后于尾部帧
    // 进入 STDOUT（I-1，spec §6 尾部先于 exited）。
    let send_queue = queue.clone();
    let send_id = terminal_id.clone();
    std::thread::spawn(move || {
        while let Some((batch, batch_end)) = send_queue.take_emit_batch() {
            for frame in batch {
                emit_frame(&send_id, generation, frame.seq, &frame.bytes);
            }
            send_queue.mark_delivered(batch_end);
        }
    });

    // 退出线程：先 wait 拿退出码，再等读线程尾部交付完毕，最后等 sender 把
    // 队列中既有帧全部写出（spec §6「尾部输出先于退出事件」；read EOF 与
    // wait 完成先后不保证），最后发 terminal.state。
    let exit_child = session.child.clone();
    let exit_queue = queue.clone();
    let exit_id = session.id.clone();
    let exit_generation = session.generation;
    std::thread::spawn(move || {
        let status = exit_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok());
        let _ = tail_rx.recv();
        exit_queue.wait_final_delivery();
        let exit_code = status.map(|status| i64::from(status.exit_code()));
        if !exit_queue.is_closed() {
            emit_state(&exit_id, exit_generation, "exited", exit_code);
        }
    });

    Ok(session)
}

impl TerminalSession {
    pub fn write_input(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "writer lock poisoned".to_string())?;
        writer
            .write_all(bytes)
            .map_err(|error| format!("write failed: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("flush failed: {error}"))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let master = self
            .master
            .lock()
            .map_err(|_| "master lock poisoned".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("resize failed: {error}"))
    }

    /// attach：打开该终端的交付闸门，返回 attach 前已缓冲、即将补放的字节数
    /// （快照语义）。幂等（spec §5 消费端流程）：重复 attach 更新消费者并
    /// 重新快照；陈旧消费者由 TS 侧代际排除，Rust 只维持单一流。
    pub fn attach(&self, consumer_id: &str) -> usize {
        let replayed = self.queue.attach(consumer_id);
        // 日志只记状态与队列指标，不记输入输出内容（spec §9）；消费者取队列
        // 内实际存储值（attach 后它才是权威），也保证该字段在生产代码有读点。
        eprintln!(
            "terminal {} attach consumer={} replayed_bytes={}",
            self.id,
            self.queue.consumer_id(),
            replayed
        );
        replayed
    }

    /// 累计确认已消费输出：归还窗口额度并唤醒被卡住的生产者。
    /// 过期/重复 ack 幂等（队列层静默 no-op）。
    pub fn ack(&self, through_output_seq: u64) {
        self.queue.ack(through_output_seq);
    }

    /// 回收：队列 close（唤醒 producer/sender/尾部等待并抑制 exited）→
    /// 经独立 killer 句柄发信号（unix 下为 SIGHUP，见库实现）→ unix 走
    /// 带时限的 SIGKILL 升级（W2-3）→ 阻塞式收割汇合点。
    /// Windows 的 ChildKiller::kill 即 TerminateProcess（已是强制终止，无需
    /// 升级阶梯），见 spec §8 平台表。master/writer 随 Arc 引用清零释放，
    /// 内核向会话前台进程组补发 SIGHUP 兜住作业控制后代。
    pub fn close(&self) {
        self.queue.close();
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        #[cfg(unix)]
        self.escalate_after_deadline();
        // 等退出线程完成收割（kill/升级后 wait 必然很快返回），保证 close
        // 返回后子进程已不存在，测试与调用方可依赖该不变量。
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
    }

    /// W2-3：SIGHUP→SIGKILL 升级。`trap '' HUP` 的 shell 会永远无视 SIGHUP，
    /// W1 的阻塞 wait 会因此卡死关停（TERMINAL-SPIKE-REPORT §4 已证实探针）。
    /// 在 HUP_DEADLINE 内以 20ms 轮询收割进度：退出线程持 child 锁阻塞时
    /// try_lock 失败即「仍在等待」；try_lock 成功且 try_wait 非 Ok(None) 即
    /// 「已收割」。超时则向子进程与其进程组发 SIGKILL——shell 经 setsid 是
    /// 组长/会话领导，同组后代（无作业控制或被内建转发的作业）随组死亡。
    /// 诚实边界（spec §6 验收边界 + spike §4）：作业控制下**其他进程组**的
    /// 后代（前台/后台独立作业）不在组信号覆盖内，依赖 master fd 释放时
    /// 内核向前台进程组补发的 SIGHUP 兜底——不承诺全部收回（spec §8：
    /// 验收只针对应用拥有和约束的进程树）。
    #[cfg(unix)]
    fn escalate_after_deadline(&self) {
        let Some(pid) = self.child_pid else { return };
        let deadline = Instant::now() + HUP_DEADLINE;
        loop {
            if let Ok(mut child) = self.child.try_lock() {
                if !matches!(child.try_wait(), Ok(None)) {
                    return;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SIGKILL 前最后再收割一次（M-5）：20 ms 轮询粒度下子进程可能恰在
        // break 前已退出——先确认，避免向可能已被新进程复用的 pgid 发组信号。
        if let Ok(mut child) = self.child.try_lock() {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
        }
        // 日志只记状态（升级事件是关停诊断的关键事实），不记输出内容。
        eprintln!(
            "terminal {} ignored SIGHUP for {:?}, escalating to SIGKILL (pid {} + group)",
            self.id, HUP_DEADLINE, pid
        );
        let pid = pid as i32;
        unsafe {
            // 先发个体（防组长已死、组信号扑空的边角），再发整组。
            libc::kill(pid, libc::SIGKILL);
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}

#[cfg(all(test, unix))]
#[path = "session_tests.rs"]
mod tests;
