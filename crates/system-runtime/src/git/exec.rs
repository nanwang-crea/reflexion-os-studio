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

/// git 运行选项：默认档（只读，15s）与写/网络档（30s / 120s + 禁交互提示）。
#[derive(Clone, Copy)]
pub(super) struct GitRunOpts {
    pub timeout_ms: u64,
    /// 网络命令禁止 git 挂起等待终端/askpass 输入（凭据缺失快速失败，stderr 引导）。
    pub noninteractive: bool,
}

pub(super) const GIT_RO: GitRunOpts = GitRunOpts {
    timeout_ms: DEFAULT_TIMEOUT_MS,
    noninteractive: false,
};
pub(super) const GIT_LOCAL_WRITE: GitRunOpts = GitRunOpts {
    timeout_ms: 30_000,
    noninteractive: false,
};
pub(super) const GIT_NETWORK: GitRunOpts = GitRunOpts {
    timeout_ms: 120_000,
    noninteractive: true,
};

/// 运行 git 并收集输出：超时杀进程，stdout/stderr 各限 512KB（防大 diff 撑爆内存）。
pub(super) fn run_git(workspace_root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_opts(workspace_root, args, GIT_RO)
}

pub(super) fn run_git_opts(
    workspace_root: &Path,
    args: &[&str],
    opts: GitRunOpts,
) -> Result<GitOutput, GitError> {
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
    if opts.noninteractive {
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "");
    }
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

    let deadline = Instant::now() + Duration::from_millis(opts.timeout_ms);
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

/// 剥除文本内所有 URL 凭据：`(scheme://)[^/\s]*@` → `$1***@`，userinfo 段按
/// **最后一个** `@` 切分（宁多遮不漏遮）。对任意消息文本幂等；无
/// `scheme://…@` 形态的文本（含普通路径、scp 形态 `git@host:path`）原样返回。
pub(super) fn scrub_url_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let after = &rest[scheme_end + 3..];
        let authority_len = after
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(after.len());
        let authority = &after[..authority_len];
        out.push_str(&rest[..scheme_end + 3]);
        match authority.rfind('@') {
            Some(at) => {
                out.push_str("***@");
                rest = &after[at + 1..];
            }
            None => rest = after,
        }
    }
    out.push_str(rest);
    out
}

/// 首行 + 统一剥除输出内 URL 凭据：所有 git_failed 消息经此进错误横幅/日志，
/// 不得携带 fetch/push/pull 回显的 `https://TOKEN@host`（AGENTS §4 secret 纪律）。
pub(super) fn first_line(text: &str) -> String {
    scrub_url_secrets(text.lines().next().unwrap_or("unknown error").trim())
}

/// stdout 末个非空行 + 同规则剥凭据：git 写命令的失败摘要（如 "nothing to
/// commit, working tree clean" / "no changes added to commit"）写在 stdout 末尾而非首行。
pub(super) fn last_nonempty_line(text: &str) -> String {
    scrub_url_secrets(
        text.lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("unknown error")
            .trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_scrubs_url_secrets_and_keeps_plain_text() {
        // 普通消息原样（含首行 trim 语义不变）。
        assert_eq!(
            first_line("  fatal: not a git repository  \nsecond line"),
            "fatal: not a git repository"
        );
        // scheme + userinfo：遮蔽整个 userinfo 段。
        assert_eq!(
            first_line("fatal: unable to access 'https://tok@h/x.git': boom"),
            "fatal: unable to access 'https://***@h/x.git': boom"
        );
        // 无 path 的 URL（authority 直到行尾）。
        assert_eq!(
            scrub_url_secrets("push to https://tok@h failed"),
            "push to https://***@h failed"
        );
        // 最后一个 @ 规则：密码含 @ 时全段遮蔽（宁多遮不漏遮）。
        assert_eq!(
            scrub_url_secrets("https://user:pa@ss@host/x"),
            "https://***@host/x"
        );
        // 幂等：二次剥除不变。
        assert_eq!(
            scrub_url_secrets(&scrub_url_secrets("https://tok@h/x")),
            "https://***@h/x"
        );
        // scp 形态无 scheme 不动；path 段的 @ 不动（userinfo 止于首个 '/'）。
        assert_eq!(
            scrub_url_secrets("git@github.com:o/r.git https://host/a@b"),
            "git@github.com:o/r.git https://host/a@b"
        );
    }

    #[test]
    fn last_nonempty_line_scrubs_too() {
        assert_eq!(
            last_nonempty_line("a\nTo https://tok@h/x.git\n"),
            "To https://***@h/x.git"
        );
        assert_eq!(last_nonempty_line(""), "unknown error");
    }
}
