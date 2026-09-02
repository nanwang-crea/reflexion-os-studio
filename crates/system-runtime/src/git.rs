//! Git Service：workspace 内只读 Git 状态与 diff（Phase 1B Git Changes 第一阶段）。
//! 仅查看与定位；编辑/暂存/提交等写操作后续阶段经权限策略接入。
//! git 为外部二进制：未安装返回 git_unavailable，非仓库返回 repo=false，
//! 其余失败 git_failed。git 输出经 LC_ALL=C 固定为英文，便于错误分类。
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::paths::resolve_in_workspace;

/// diff 文本最大返回字节数（超出截断并标记），同时限制 status 输出。
pub const MAX_DIFF_BYTES: usize = 512 * 1024;
/// git 命令最坏执行时间（只读操作，超时杀进程）。
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 变更条目上限：仓库特别脏时防一次吃掉资源，超出标记 truncated。
const MAX_STATUS_ENTRIES: usize = 5000;

pub struct GitError {
    pub code: &'static str,
    pub message: String,
}

impl GitError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
    pub staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub repo: bool,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutcome {
    pub repo: bool,
    pub diff: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchesOutcome {
    pub repo: bool,
    /// 当前所在分支；HEAD detached 或无分支时返回 None。
    pub current: Option<String>,
    /// 本地分支名列表（refs/heads/*），按名称排序。
    pub branches: Vec<String>,
}

struct GitOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
    timed_out: bool,
}

/// 工作树 Git 状态（untracked 一并列出）；非仓库返回 repo=false。
pub fn status(workspace_root: &Path) -> Result<StatusOutcome, GitError> {
    let output = run_git(
        workspace_root,
        &[
            "--no-pager",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git status timed out".to_string(),
        ));
    }
    match output.exit_code {
        Some(0) => Ok(parse_status(&output.stdout)),
        // 非仓库:status 报 fatal(exit 128,小写),diff 报 warning+usage(exit 129,
        // 大写 Not),统一按 stderr 内容识别,不依赖退出码。
        _ if output
            .stderr
            .to_lowercase()
            .contains("not a git repository") =>
        {
            Ok(StatusOutcome {
                repo: false,
                entries: Vec::new(),
                truncated: false,
            })
        }
        _ => Err(GitError::new(
            "git_failed",
            first_line(&output.stderr).to_string(),
        )),
    }
}

/// 单文件的 unified diff；staged 时取索引版本。非仓库返回 repo=false。
pub fn diff(workspace_root: &Path, relative: &str, staged: bool) -> Result<DiffOutcome, GitError> {
    resolve_in_workspace(workspace_root, relative)
        .map_err(|message| GitError::new("path_outside_workspace", message))?;
    let mut args: Vec<&str> = vec!["--no-pager", "diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", relative]);
    let output = run_git(workspace_root, &args)?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git diff timed out".to_string(),
        ));
    }
    match output.exit_code {
        Some(0) => Ok(DiffOutcome {
            repo: true,
            diff: output.stdout,
            truncated: output.truncated,
        }),
        _ if output
            .stderr
            .to_lowercase()
            .contains("not a git repository") =>
        {
            Ok(DiffOutcome {
                repo: false,
                diff: String::new(),
                truncated: false,
            })
        }
        _ => Err(GitError::new(
            "git_failed",
            first_line(&output.stderr).to_string(),
        )),
    }
}

/// 解析 `git status --porcelain=v1 -z` 输出。
/// -z 下换行不再转义（空格/引号/非 ASCII 原样），记录以 \0 分隔；
/// 每条记录为 `XY <路径>`（2 状态字符 + 空格），重命名/复制由两段组成：
/// 第一段为 `XY <新路径>`，第二段为 `<旧路径>`（与普通格式的 old -> new 相反）。
fn parse_status(stdout: &str) -> StatusOutcome {
    let records: Vec<&[u8]> = stdout.split('\0').map(str::as_bytes).collect();
    let mut entries: Vec<StatusEntry> = Vec::new();
    let mut truncated = false;
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES || record.len() < 3 {
            truncated = true;
            break;
        }
        let xy = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let (status, staged) = classify_xy(xy[0], xy[1]);
        let old_path = if matches!(status, "renamed") {
            index += 1;
            let old = records.get(index).copied().unwrap_or_default();
            if old.is_empty() {
                truncated = true;
                break;
            }
            Some(String::from_utf8_lossy(old).into_owned())
        } else {
            None
        };
        entries.push(StatusEntry {
            path,
            old_path,
            status,
            staged,
        });
        index += 1;
    }
    StatusOutcome {
        repo: true,
        entries,
        truncated,
    }
}

/// XY 状态 → 变化类别与 staged 标记（X=索引, Y=工作树）。
fn classify_xy(x: u8, y: u8) -> (&'static str, bool) {
    if x == b'?' || y == b'?' {
        return ("untracked", false);
    }
    let conflict = matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'));
    if conflict {
        return ("conflicted", false);
    }
    if matches!((x, y), (b'R', _) | (_, b'R') | (b'C', _) | (_, b'C')) {
        return ("renamed", x != b' ');
    }
    if x == b'D' || y == b'D' {
        return ("deleted", x == b'D');
    }
    if x == b'A' || y == b'A' {
        return ("added", x == b'A');
    }
    return ("modified", x != b' ');
}

/// 本地分支列表（refs/heads/*）与当前分支；非仓库返回 repo=false，HEAD detached
/// 视为"无当前分支"（dialog 下可能发生在切换 commit 时）。
pub fn branches(workspace_root: &Path) -> Result<BranchesOutcome, GitError> {
    let current_output = run_git(workspace_root, &["--no-pager", "branch", "--show-current"])?;
    if current_output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git branch timed out".to_string(),
        ));
    }
    // 非仓库：branch 也报 fatal(exit 128,小写"not a git repository")。
    let not_a_repo = |output: &GitOutput| {
        output
            .stderr
            .to_lowercase()
            .contains("not a git repository")
    };
    if current_output.exit_code != Some(0) {
        if not_a_repo(&current_output) {
            return Ok(BranchesOutcome {
                repo: false,
                current: None,
                branches: Vec::new(),
            });
        }
        return Err(GitError::new(
            "git_failed",
            first_line(&current_output.stderr).to_string(),
        ));
    }
    let current = trim_to_none(&current_output.stdout);
    let list_output = run_git(
        workspace_root,
        &[
            "--no-pager",
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?;
    if list_output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git branch list timed out".to_string(),
        ));
    }
    if list_output.exit_code != Some(0) {
        return Err(GitError::new(
            "git_failed",
            first_line(&list_output.stderr).to_string(),
        ));
    }
    let branches = list_output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    Ok(BranchesOutcome {
        repo: true,
        current,
        branches,
    })
}

/// inner trim 后非空则返回，空串 → None（用于 --show-current 的输出）。
fn trim_to_none(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("unknown error").trim()
}

/// 运行 git 并收集输出：超时杀进程，stdout/stderr 各限 512KB（防大 diff 撑爆内存）。
fn run_git(workspace_root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
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
    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    let truncated = stdout.len() >= MAX_DIFF_BYTES;
    Ok(GitOutput {
        exit_code: status.and_then(|value| value.code()),
        stdout,
        stderr,
        truncated,
        timed_out,
    })
}

fn find_git_executable() -> Option<std::path::PathBuf> {
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
fn drain_pipe<T: Read + Send + 'static>(pipe: &mut Option<T>) -> std::thread::JoinHandle<String> {
    let mut pipe = pipe.take();
    std::thread::spawn(move || {
        let mut collected: Vec<u8> = Vec::new();
        if let Some(pipe) = pipe.as_mut() {
            let mut buffer = [0u8; 8192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let remaining = MAX_DIFF_BYTES.saturating_sub(collected.len());
                        if remaining == 0 {
                            continue; // 读完丢弃，保持管道畅通
                        }
                        let take = read.min(remaining);
                        collected.extend_from_slice(&buffer[..take]);
                    }
                    Err(_) => break,
                }
            }
        }
        String::from_utf8_lossy(&collected).into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v1_z_records() {
        // 与实测一致：普通记录 `XY path\0`，重命名两段 `R  new\0old\0`。
        let input = " M a.txt\0 D b.txt\0R  renamed.txt\0c.txt\0A  x.txt\0?? new.txt\0";
        let outcome = parse_status(input);
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.truncated, false);
        let keys: Vec<(&str, &str, bool)> = outcome
            .entries
            .iter()
            .map(|entry| (entry.status, entry.path.as_str(), entry.staged))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("modified", "a.txt", false),
                ("deleted", "b.txt", false),
                ("renamed", "renamed.txt", true),
                ("added", "x.txt", true),
                ("untracked", "new.txt", false),
            ]
        );
        let rename = outcome.entries.get(2).unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("c.txt"));
    }

    #[test]
    fn classifies_conflict_and_index_states() {
        assert_eq!(classify_xy(b'U', b'U'), ("conflicted", false));
        assert_eq!(classify_xy(b'A', b' '), ("added", true));
        assert_eq!(classify_xy(b' ', b'A'), ("added", false));
        assert_eq!(classify_xy(b'M', b' '), ("modified", true));
        assert_eq!(classify_xy(b' ', b'M'), ("modified", false));
        assert_eq!(classify_xy(b'D', b' '), ("deleted", true));
        assert_eq!(classify_xy(b'?', b'?'), ("untracked", false));
    }

    #[test]
    fn truncates_on_excessive_entries_and_empty_rename_old() {
        let mut input = String::new();
        for _ in 0..(MAX_STATUS_ENTRIES + 1) {
            input.push_str(" M f.txt\0");
        }
        let outcome = parse_status(&input);
        assert_eq!(outcome.entries.len(), MAX_STATUS_ENTRIES);
        assert_eq!(outcome.truncated, true);

        let missing_old = parse_status("R  new.txt\0");
        assert_eq!(missing_old.truncated, true);
    }
}
