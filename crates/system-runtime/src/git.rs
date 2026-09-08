//! Git Service：workspace 内只读 Git 状态与 diff（Phase 1B Git Changes 第一阶段）。
//! 仅查看与定位；编辑/暂存/提交等写操作后续阶段经权限策略接入。
//! git 为外部二进制：未安装返回 git_unavailable，非仓库返回 repo=false，
//! 其余失败 git_failed。git 输出经 LC_ALL=C 固定为英文，便于错误分类。
use std::fs;
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

#[derive(Debug)]
pub struct GitError {
    pub code: &'static str,
    pub message: String,
}

impl GitError {
    fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

/// 单侧内容：git 对象内容或工作树文件内容（上限 MAX_DIFF_BYTES）。
struct BlobContent {
    text: String,
    truncated: bool,
}

impl Default for BlobContent {
    fn default() -> Self {
        Self {
            text: String::new(),
            truncated: false,
        }
    }
}

/// `git show` 结果分类：有内容 / 路径不在该树（视为空基线）/ 非仓库。
enum BlobLookup {
    Content(BlobContent),
    Absent,
    NotARepo,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOutcome {
    pub repo: bool,
    /// 左侧基线内容：工作树 diff 取索引版本，已暂存 diff 取 HEAD 版本；
    /// 新增/未跟踪文件为空串。
    pub original: String,
    /// 右侧内容：工作树 diff 取工作树文件（删除为空串），已暂存 diff 取索引版本。
    pub modified: String,
    pub truncated: bool,
    pub binary: bool,
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

/// 单文件 diff 两侧内容：staged=false 为 索引 → 工作树，staged=true 为
/// HEAD → 索引。original/modified 直接取自 git 对象与磁盘文件，不经
/// diff 文本反推（反推对新增/删除/大文件/二进制均有不可修的失真）。
/// 路径不在对应树中（新增/删除）按空串处理；非仓库返回 repo=false。
pub fn diff(workspace_root: &Path, relative: &str, staged: bool) -> Result<DiffOutcome, GitError> {
    resolve_in_workspace(workspace_root, relative)
        .map_err(|message| GitError::new("path_outside_workspace", message))?;
    // `:<rev>:./path` 相对 cwd（= workspace root）解析，与 pathspec 语义一致。
    let base_query = if staged {
        format!("HEAD:./{relative}")
    } else {
        format!(":./{relative}")
    };
    let original = match read_git_blob(workspace_root, &base_query)? {
        BlobLookup::Content(content) => content,
        BlobLookup::Absent => BlobContent::default(),
        BlobLookup::NotARepo => return Ok(repo_false_diff()),
    };
    // 右侧：已暂存取索引版本；工作树取磁盘文件（不存在 = 删除 → 空）。
    let modified = if staged {
        match read_git_blob(workspace_root, &format!(":./{relative}"))? {
            BlobLookup::Content(content) => content,
            BlobLookup::Absent => BlobContent::default(),
            BlobLookup::NotARepo => return Ok(repo_false_diff()),
        }
    } else {
        read_worktree_file(workspace_root, relative)?
    };
    let binary = looks_binary(&original.text) || looks_binary(&modified.text);
    Ok(DiffOutcome {
        repo: true,
        original: original.text,
        modified: modified.text,
        truncated: original.truncated || modified.truncated,
        binary,
    })
}

fn repo_false_diff() -> DiffOutcome {
    DiffOutcome {
        repo: false,
        original: String::new(),
        modified: String::new(),
        truncated: false,
        binary: false,
    }
}

/// git 同款二进制启发式：前 8000 字节出现 NUL 视为二进制。
fn looks_binary(text: &str) -> bool {
    text.as_bytes().iter().take(8000).any(|byte| *byte == 0)
}

/// 读取工作树文件内容（限 MAX_DIFF_BYTES）；文件不存在（工作树删除）按空处理。
/// 读取后按 git 的 checkout 侧换行策略归一化回 LF，与树内对象（clean 侧，
/// 恒为 LF）对齐：否则 core.autocrlf=true（Windows 默认）或 eol=crlf 属性
/// 会把未变更文件逐行误报为已修改。
fn read_worktree_file(workspace_root: &Path, relative: &str) -> Result<BlobContent, GitError> {
    let path = resolve_in_workspace(workspace_root, relative)
        .map_err(|message| GitError::new("path_outside_workspace", message))?;
    match fs::read(&path) {
        Ok(bytes) => {
            // checkout 侧策略命中（autocrlf=true / eol=crlf）时归一化回 LF，
            // 与树内对象（clean 侧恒为 LF）对齐；未命中时工作树与树内一致。
            let eol = worktree_eol(workspace_root).unwrap_or(EolPolicy::AsIs);
            let bytes = match eol {
                EolPolicy::AsIs => bytes,
                EolPolicy::NormalizeCrlf => normalize_crlf(bytes),
            };
            Ok(limit_bytes(bytes, false))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BlobContent::default()),
        Err(error) => Err(GitError::new(
            "git_failed",
            format!("read worktree file failed: {error}"),
        )),
    }
}

/// 工作树换行策略（checkout 侧）：`core.autocrlf=true` 或 `.gitattributes`
/// 对该路径声明 `eol=crlf` 时，git 在 checkout 会把 LF 写为 CRLF，读取侧
/// 需要归一化回 LF 才能与树内对象对齐；其余情况工作树与树内一致，不转换。
#[derive(Debug, PartialEq, Eq)]
enum EolPolicy {
    AsIs,
    NormalizeCrlf,
}

fn worktree_eol(workspace_root: &Path) -> Option<EolPolicy> {
    // `input` 只影响 commit 侧（工作树保持 LF），checkout 侧无需归一化。
    if let Some(autocrlf) = git_config_value(workspace_root, "core.autocrlf") {
        if autocrlf.eq_ignore_ascii_case("true") {
            return Some(EolPolicy::NormalizeCrlf);
        }
    }
    git_attributes_eol(workspace_root)
}

/// 读取单个配置键；未设置或执行失败返回 None。
fn git_config_value(workspace_root: &Path, key: &str) -> Option<String> {
    let output = run_git(workspace_root, &["config", "--null", "--get", key]).ok()?;
    if output.exit_code == Some(0) {
        Some(output.stdout.trim_end_matches('\0').to_string())
    } else {
        None
    }
}

/// `.gitattributes` 中对该路径声明的 eol；未命中或不可用返回 None。
fn git_attributes_eol(workspace_root: &Path) -> Option<EolPolicy> {
    let output = run_git(
        workspace_root,
        &["check-attr", "--null", "text", "eol", "--", "."],
    )
    .ok()?;
    if output.exit_code != Some(0) {
        return None;
    }
    parse_check_attr_eol(&output.stdout)
}

/// 解析 `git check-attr -z text eol -- .` 的 `path NUL attr NUL value NUL` 流。
/// eol=crlf（或 text=auto 且平台为 Windows 的等价场景）→ 归一化；eol=lf → 原样。
fn parse_check_attr_eol(stdout: &str) -> Option<EolPolicy> {
    let mut parts = stdout.split('\0');
    while let (Some(_path), Some(attr)) = (parts.next(), parts.next()) {
        let value = parts.next()?.trim_end_matches('\0');
        if attr == "eol" {
            return match value {
                "crlf" => Some(EolPolicy::NormalizeCrlf),
                "lf" => Some(EolPolicy::AsIs),
                _ => None,
            };
        }
    }
    None
}

/// checkout 侧归一化：CRLF → LF（保留孤立 \r，不动二进制里无 \r\n 的字节）。
fn normalize_crlf(bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.windows(2).any(|window| window == b"\r\n") {
        return bytes;
    }
    let mut result = Vec::with_capacity(bytes.len());
    let mut iter = bytes.into_iter().peekable();
    while let Some(byte) = iter.next() {
        if byte == b'\r' && iter.peek() == Some(&b'\n') {
            result.push(b'\n');
            iter.next();
        } else {
            result.push(byte);
        }
    }
    result
}

fn limit_bytes(bytes: Vec<u8>, pipe_truncated: bool) -> BlobContent {
    // 管道层可能已按 MAX_DIFF_BYTES 截断（长度恰好等于上限时 re-derive 恒为 false），
    // 磁盘读取未截断则按长度补判。
    let truncated = pipe_truncated || bytes.len() > MAX_DIFF_BYTES;
    let owned = if bytes.len() > MAX_DIFF_BYTES {
        bytes[..MAX_DIFF_BYTES].to_vec()
    } else {
        bytes
    };
    BlobContent {
        text: String::from_utf8_lossy(&owned).into_owned(),
        truncated,
    }
}

/// `git show <query>` 读取一个树内对象内容。
/// - exit 0：有内容；
/// - exit 128 且报 path 不存在 / 不在 tree / invalid object：该树中无此路径（Absent）；
/// - 报 not a git repository：非仓库；
/// - 其余为 git_failed。
fn read_git_blob(workspace_root: &Path, query: &str) -> Result<BlobLookup, GitError> {
    let output = run_git(workspace_root, &["--no-pager", "show", query])?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git show timed out".to_string(),
        ));
    }
    match output.exit_code {
        Some(0) => Ok(BlobLookup::Content(limit_bytes(
            output.stdout.into_bytes(),
            output.truncated,
        ))),
        Some(128)
            if output.stderr.contains("does not exist")
                || output.stderr.contains("not in the working tree")
                || output.stderr.contains("exists on disk, but not in")
                || output.stderr.contains("unknown revision or path not in")
                || output.stderr.contains("invalid object name") =>
        {
            Ok(BlobLookup::Absent)
        }
        _ if output
            .stderr
            .to_lowercase()
            .contains("not a git repository") =>
        {
            Ok(BlobLookup::NotARepo)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "reflexion-git-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 供测试用的 git CLI 执行（find_git_executable 为真源）；不可用则跳过用例。
    fn git_cli(root: &Path, args: &[&str]) -> bool {
        let Some(executable) = find_git_executable() else {
            eprintln!("skip: git executable not found");
            return false;
        };
        let status = Command::new(executable)
            .current_dir(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .expect("spawn git for test fixture");
        assert!(status.success(), "git {args:?} failed in fixture");
        true
    }

    /// 初始化带一次提交的临时仓库；git 不可用时返回 false（用例跳过）。
    fn temp_repo(tag: &str) -> Option<PathBuf> {
        let root = temp_workspace(tag);
        if !git_cli(&root, &["init", "-q"]) {
            return None;
        }
        Some(root)
    }

    fn write(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn diff_unstaged_uses_index_as_original_and_worktree_as_modified() {
        let Some(root) = temp_repo("unstaged") else {
            return;
        };
        write(&root, "f.txt", b"old line\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "f.txt", b"new line\n");

        let outcome = diff(&root, "f.txt", false).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.original, "old line\n");
        assert_eq!(outcome.modified, "new line\n");
        assert_eq!(outcome.binary, false);
        assert_eq!(outcome.truncated, false);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_staged_uses_head_as_original_and_index_as_modified() {
        let Some(root) = temp_repo("staged") else {
            return;
        };
        write(&root, "f.txt", b"head line\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "f.txt", b"index line\n");
        assert!(git_cli(&root, &["add", "f.txt"]));

        let outcome = diff(&root, "f.txt", true).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.original, "head line\n");
        assert_eq!(outcome.modified, "index line\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_untracked_file_diffs_as_full_addition() {
        let Some(root) = temp_repo("untracked") else {
            return;
        };
        write(&root, "seed.txt", b"seed\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "new.txt", b"whole file\n");

        let outcome = diff(&root, "new.txt", false).unwrap();
        assert_eq!(outcome.original, "");
        assert_eq!(outcome.modified, "whole file\n");
        fs::remove_dir_all(&root).ok();
    }

    /// core.autocrlf=true 时工作树里的 CRLF 必须归一化回 LF 再对比，
    /// 否则未变更文件会被逐行误报为已修改（Git for Windows 默认场景）。
    #[test]
    fn diff_autocrlf_worktree_normalizes_crlf_to_lf() {
        let Some(root) = temp_repo("autocrlf") else {
            return;
        };
        assert!(git_cli(&root, &["config", "core.autocrlf", "true"]));
        write(&root, "f.txt", b"same content\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        // 模拟 Windows checkout：内容未变，但工作树是 CRLF。
        write(&root, "f.txt", b"same content\r\n");

        let outcome = diff(&root, "f.txt", false).unwrap();
        assert_eq!(outcome.original, "same content\n");
        assert_eq!(outcome.modified, "same content\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_staged_new_file_diffs_as_full_addition() {
        let Some(root) = temp_repo("staged-new") else {
            return;
        };
        write(&root, "seed.txt", b"seed\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "new.txt", b"whole file\n");
        assert!(git_cli(&root, &["add", "new.txt"]));

        let outcome = diff(&root, "new.txt", true).unwrap();
        assert_eq!(outcome.original, "");
        assert_eq!(outcome.modified, "whole file\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_worktree_deletion_diffs_as_full_removal() {
        let Some(root) = temp_repo("deletion") else {
            return;
        };
        write(&root, "f.txt", b"gone soon\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        fs::remove_file(root.join("f.txt")).unwrap();

        let outcome = diff(&root, "f.txt", false).unwrap();
        assert_eq!(outcome.original, "gone soon\n");
        assert_eq!(outcome.modified, "");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_binary_content_is_flagged() {
        let Some(root) = temp_repo("binary") else {
            return;
        };
        write(&root, "blob.bin", b"a\0b");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "blob.bin", b"a\0c");

        let outcome = diff(&root, "blob.bin", false).unwrap();
        assert_eq!(outcome.binary, true);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_oversized_content_is_truncated() {
        let Some(root) = temp_repo("oversize") else {
            return;
        };
        let big = vec![b'x'; MAX_DIFF_BYTES + 4096];
        write(&root, "big.txt", &big);
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        write(&root, "big.txt", b"small\n");

        let outcome = diff(&root, "big.txt", false).unwrap();
        assert_eq!(outcome.truncated, true);
        assert_eq!(outcome.modified, "small\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_non_repo_directory_reports_repo_false() {
        let root = temp_workspace("non-repo");
        write(&root, "f.txt", b"plain\n");
        if find_git_executable().is_none() {
            eprintln!("skip: git executable not found");
            return;
        }
        let outcome = diff(&root, "f.txt", false).unwrap();
        assert_eq!(outcome.repo, false);
        assert_eq!(outcome.original, "");
        assert_eq!(outcome.modified, "");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_rejects_path_outside_workspace() {
        let root = temp_workspace("outside");
        if find_git_executable().is_none() {
            eprintln!("skip: git executable not found");
            return;
        }
        let error = diff(&root, "../outside.txt", false).unwrap_err();
        assert_eq!(error.code, "path_outside_workspace");
        fs::remove_dir_all(&root).ok();
    }

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
