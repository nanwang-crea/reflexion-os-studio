//! Shell Service：workspace 内执行命令，带超时、输出上限与进程树回收。
//! 平台分支显式：POSIX 走 `sh -c` + 进程组；Windows 走 `cmd /C` + taskkill 树杀。
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

pub fn execute(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    let timeout_ms = timeout_ms.min(MAX_TIMEOUT_MS);
    if !cwd.is_dir() {
        return Err("shell cwd does not exist".to_string());
    }

    let mut cmd = build_command(command);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组：超时时 kill(-pgid) 连孙进程一起回收（如 `sh -c "sleep 5 &"`）。
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("spawn failed: {error}"))?;
    on_spawn(child.id());
    let pgid = child.id();
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_handle = drain_pipe(&mut stdout_pipe);
    let stderr_handle = drain_pipe(&mut stderr_pipe);

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    kill_tree(pgid);
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("wait failed: {error}")),
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    let truncated = stdout.len() >= MAX_OUTPUT_BYTES || stderr.len() >= MAX_OUTPUT_BYTES;
    Ok(ShellOutcome {
        exit_code: status.and_then(|status| status.code()),
        stdout,
        stderr,
        timed_out,
        truncated,
    })
}

fn build_command(command: &str) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", command]);
        cmd
    }
}

fn drain_pipe<T: Read + Send + 'static>(pipe: &mut Option<T>) -> std::thread::JoinHandle<String> {
    let mut pipe = pipe.take();
    std::thread::spawn(move || {
        let mut collected: Vec<u8> = Vec::new();
        let mut truncated = false;
        if let Some(pipe) = pipe.as_mut() {
            let mut buffer = [0u8; 8192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let remaining = MAX_OUTPUT_BYTES.saturating_sub(collected.len());
                        if remaining == 0 {
                            truncated = true;
                            continue; // 读完丢弃，保持管道畅通避免子进程阻塞
                        }
                        let take = read.min(remaining);
                        collected.extend_from_slice(&buffer[..take]);
                        if take < read {
                            truncated = true;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        let _ = truncated;
        String::from_utf8_lossy(&collected).into_owned()
    })
}

pub(crate) fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 测试专用：基于内容派生确定性的临时工作目录。
#[cfg(test)]
pub fn temp_dir(tag: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reflexion-shell-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn captures_output_and_exit_code() {
        let cwd = temp_dir("capture");
        let outcome = execute("printf hello; exit 3", &cwd, 10_000, &|_| {}).unwrap();
        assert_eq!(outcome.stdout, "hello");
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out);
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn times_out_and_kills_process_tree() {
        let cwd = temp_dir("timeout");
        let started = Instant::now();
        let outcome = execute("sleep 30", &cwd, 500, &|_| {}).unwrap();
        assert!(outcome.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
        std::fs::remove_dir_all(&cwd).ok();
    }

    #[test]
    fn kills_background_grandchildren_via_process_group() {
        // `sleep 30 & wait`：sleep 是同进程组的孙进程，前台 sh 因 wait 保持存活；
        // 超时 kill(-pgid) 后必须连 sleep 一起消失。
        let cwd = temp_dir("grandchild");
        let marker = cwd.join("marker");
        let outcome = execute(
            &format!("sleep 30 & echo $! > {} ; wait", marker.display()),
            &cwd,
            500,
            &|_| {},
        )
        .unwrap();
        assert!(outcome.timed_out);
        std::thread::sleep(Duration::from_millis(300));
        let pid = std::fs::read_to_string(&marker).unwrap().trim().to_string();
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(!alive, "grandchild process {pid} should be reaped");
        std::fs::remove_dir_all(&cwd).ok();
    }
}
