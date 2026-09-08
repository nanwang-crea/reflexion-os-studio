//! Git Service：workspace 内只读 Git 状态与 diff（Phase 1B Git Changes 第一阶段）。
//! 仅查看与定位；编辑/暂存/提交等写操作后续阶段经权限策略接入。
//! git 为外部二进制：未安装返回 git_unavailable，非仓库返回 repo=false，
//! 其余失败 git_failed。
//! 实现拆分：状态解析在 status.rs、diff 内容读取在 diff.rs、进程执行在 exec.rs。

use std::path::Path;

use serde::Serialize;

use super::diff::{diff as diff_impl, DiffOutcome};
use super::exec::{first_line, run_git};
use super::status::{status as status_impl, StatusOutcome};

/// git 子系统统一错误分类：git_unavailable / git_failed / path_outside_workspace。
#[derive(Debug)]
pub struct GitError {
    pub code: &'static str,
    pub message: String,
}

impl GitError {
    pub(super) fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

/// git 命令最坏执行时间（只读操作，超时杀进程）。
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchesOutcome {
    pub repo: bool,
    /// 当前所在分支；HEAD detached 或无分支时返回 None。
    pub current: Option<String>,
    /// 本地分支名列表（refs/heads/*），按名称排序。
    pub branches: Vec<String>,
}

/// 工作树 Git 状态（untracked 一并列出）；非仓库返回 repo=false。
pub fn status(workspace_root: &Path) -> Result<StatusOutcome, GitError> {
    status_impl(workspace_root)
}

/// 单文件 diff 两侧内容（详见 diff::diff）。
pub fn diff(workspace_root: &Path, relative: &str, staged: bool) -> Result<DiffOutcome, GitError> {
    diff_impl(workspace_root, relative, staged)
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
    if current_output.exit_code != Some(0) {
        if super::status::is_not_a_repo(&current_output) {
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    use super::super::exec::find_git_executable;
    use super::*;

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
        let big = vec![b'x'; super::super::diff::MAX_DIFF_BYTES + 4096];
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
}
