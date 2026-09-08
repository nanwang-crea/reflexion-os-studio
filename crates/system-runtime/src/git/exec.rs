//! git 子进程执行：可执行文件查找（三平台候选 + REFLEXION_GIT_PATH）、
//! 超时受控运行、管道受限排空。LC_ALL=C 固定英文输出，便于错误分类。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::diff::MAX_DIFF_BYTES;
use super::service::GitError;
use super::service::DEFAULT_TIMEOUT_MS;

pub(super) struct GitOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}

/// 运行 git 并收集输出：超时杀进程，stdout/stderr 各限 512KB（防大 diff 撑爆内存）。
pub(super) fn run_git(workspace_root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    let executable = find_git_executable().ok_or_else(|| {
        GitError::new(
            "git_unavailable",
            "git not found; install Git or configure REFLEXION_GIT_PATH".to_string(),
        )
    })?;
    let mut command = Command::new(executable);
    command
        .current_dir(workspace_root)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GitError::new("git_unavailable", "git not found".to_string())
        } else {
            GitError::new("git_failed", format!("spawn git failed: {error}"))
        }
    })?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_handle = drain_pipe(&mut stdout_pipe);
    let stderr_handle = drain_pipe(&mut stderr_pipe);

    let deadline = Instant::now() + Duration::from_millis(DEFAULT_TIMEOUT_MS);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(GitError::new("git_failed", format!("wait failed: {error}")));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_handle.join().unwrap_or_default();
    let (stderr, stderr_truncated) = stderr_handle.join().unwrap_or_default();
    let truncated = stdout_truncated || stderr_truncated;
    Ok(GitOutput {
        exit_code: status.and_then(|value| value.code()),
        stdout,
        stderr,
        truncated,
        timed_out,
    })
}

pub(super) fn find_git_executable() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("REFLEXION_GIT_PATH") {
        let candidate = std::path::PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("git")));
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        std::path::PathBuf::from("/usr/bin/git"),
        std::path::PathBuf::from("/opt/homebrew/bin/git"),
        std::path::PathBuf::from("/usr/local/bin/git"),
    ]);
    #[cfg(target_os = "windows")]
    candidates.extend([
        std::path::PathBuf::from(r"C:\\Program Files\\Git\\cmd\\git.exe"),
        std::path::PathBuf::from(r"C:\\Program Files\\Git\\bin\\git.exe"),
    ]);
    #[cfg(target_os = "linux")]
    candidates.push(std::path::PathBuf::from("/usr/bin/git"));
    candidates.into_iter().find(|path| path.is_file())
}

/// 后台排空子进程管道：受限收集，避免子进程写满管道而阻塞。
fn drain_pipe<T: Read + Send + 'static>(
    pipe: &mut Option<T>,
) -> std::thread::JoinHandle<(String, bool)> {
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
                        let remaining = MAX_DIFF_BYTES.saturating_sub(collected.len());
                        if remaining == 0 {
                            truncated = true;
                            continue;
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
        (String::from_utf8_lossy(&collected).into_owned(), truncated)
    })
}

pub(super) fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("unknown error").trim()
}
