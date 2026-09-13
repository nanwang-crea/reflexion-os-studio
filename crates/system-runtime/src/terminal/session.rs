//! 单个 PTY 会话（W1 切片）：读线程 → ≤16 KiB 帧 + 终端内 outputSeq + base64
//! 通知输出；写/resize；close/exited 收尾。背压额度与消费者代际在 W2 补。
//!
//! portable-pty 0.8.1 实测校准（预飞行核查）：
//! - `wait()` 返回 `ExitStatus`（`code: u32` + 私有 `signal: Option<String>`），
//!   不存在 `WaitStatus` 枚举；公开 API 无法读取信号名——被信号终止的进程
//!   统一报告 crate 映射后的退出码（通常为 1），W1 如实透传，不伪造负数信号。
//! - `CommandBuilder` 没有 `term()` 方法，TERM 经 `env()` 显式注入。
//! - `Child::wait` 会在退出线程长时间持有 child 锁；`close()` 必须经
//!   `clone_killer()` 拿独立 killer 句柄发信号（库注释明示的用法），
//!   否则 kill 永远拿不到锁、close 挂死。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;

use crate::protocol::emit;
use crate::terminal::shell_command::default_shell_argv;

pub const MAX_FRAME_BYTES: usize = 16 * 1024;

pub struct TerminalSession {
    pub id: String,
    pub generation: u64,
    pub output_seq: AtomicU64,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: Arc<AtomicBool>,
}

/// 16 KiB 上限分帧；同终端 outputSeq 连续，消费端据此检测缺口。
fn emit_output(session: &TerminalSession, bytes: &[u8]) {
    for chunk in bytes.chunks(MAX_FRAME_BYTES) {
        let seq = session.output_seq.fetch_add(1, Ordering::SeqCst);
        emit(json!({
            "jsonrpc": "2.0",
            "method": "terminal.output",
            "params": {
                "terminalId": session.id,
                "outputSeq": seq,
                "generation": session.generation,
                "data": base64::engine::general_purpose::STANDARD.encode(chunk),
            }
        }));
    }
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

#[allow(dead_code)] // W1 分步交付：Task 11 服务接线前仅测试消费。
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

    let session = Arc::new(TerminalSession {
        id: terminal_id.clone(),
        generation,
        output_seq: AtomicU64::new(0),
        writer: Mutex::new(writer),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        killer: Mutex::new(killer),
        closed: Arc::new(AtomicBool::new(false)),
    });

    // 读线程：EOF（子进程退出/最后一个从属 fd 关闭）后交付完毕，通知退出线程收尾。
    let read_session = session.clone();
    let (tail_tx, tail_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => emit_output(&read_session, &buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = tail_tx.send(());
    });

    // 退出线程：先 wait 拿退出码，再等读线程尾部交付完毕，最后发 terminal.state
    //（顺序保证 spec §6「尾部输出先于退出事件」；read EOF 与 wait 完成先后不保证）。
    let exit_child = session.child.clone();
    let exit_id = session.id.clone();
    let exit_generation = session.generation;
    let exit_closed = session.closed.clone();
    std::thread::spawn(move || {
        let status = exit_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok());
        let _ = tail_rx.recv();
        let exit_code = status.map(|status| i64::from(status.exit_code()));
        if !exit_closed.load(Ordering::SeqCst) {
            emit_state(&exit_id, exit_generation, "exited", exit_code);
        }
    });

    emit_state(&terminal_id, generation, "running", None);
    Ok(session)
}

// 服务消费方（Task 11）接线前，以下方法仅被 unix 测试驱动；方法体也是
// writer/master/killer 字段的唯一读者，故整块豁免 dead_code。
#[allow(dead_code)]
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

    /// 回收：置 closed（抑制退出线程的 terminal.state）、经独立 killer 句柄
    /// kill（unix 下为 SIGHUP，见库实现），再阻塞式收割子进程。
    /// 不能直接对 child 锁 kill：退出线程的 `wait()` 长期持有 child 锁，
    /// 故 clone_killer 是这里唯一的正确入口。master/writer 随 Arc 引用清零
    /// 释放，内核向会话前台进程组发 SIGHUP 兜住作业控制后代。
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        // 等退出线程完成收割（kill 后 wait 必然很快返回），保证 close 返回后
        // 子进程已不存在，测试与调用方可依赖该不变量。
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn payload_is_chunked_at_16kib_boundary() {
        let payload = vec![0x41u8; MAX_FRAME_BYTES * 2 + 1];
        let sizes: Vec<usize> = payload.chunks(MAX_FRAME_BYTES).map(<[u8]>::len).collect();
        assert_eq!(sizes, vec![MAX_FRAME_BYTES, MAX_FRAME_BYTES, 1]);
    }

    #[test]
    fn echo_roundtrip_over_real_pty() {
        let session = spawn("itest".to_string(), 7, "/tmp", 24, 80).expect("spawn");
        session
            .write_input(b"echo TERMINAL_OK_$((1+2))\r\n")
            .expect("write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while session.output_seq.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline
        {
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
}
