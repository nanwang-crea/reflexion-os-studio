//! Git 写类子命令：argv 全部按命令枚举固定拼装，路径/分支名服务端校验；
//! UI 命令由 Runtime 声明来源（本层免 grant——grant 属 agent 工具链边界）。

use std::path::Path;

use serde_json::{json, Value};

use super::exec::{
    first_line, last_nonempty_line, run_git_opts, GitRunOpts, GIT_LOCAL_WRITE, GIT_NETWORK, GIT_RO,
};
use super::service::GitError;

/// 空 paths 会让 `git reset --` 退化为全量取消暂存（`git add --` 同样非本意）；
/// 进程边界层不得依赖上游 zod min(1)，在此显式拒绝。
fn require_paths(paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Err(GitError::new(
            "invalid_request",
            "no paths supplied".to_string(),
        ));
    }
    Ok(())
}

fn validate_rel_path(path: &str) -> Result<&str, GitError> {
    if path.is_empty()
        || path.contains("..")
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.chars().any(|c| c.is_ascii_control())
    {
        return Err(GitError::new(
            "path_outside_workspace",
            format!("invalid workspace path: {path}"),
        ));
    }
    Ok(path)
}

/// 分支名保守白名单（防注入/畸形 ref；git 完整规则更严，超集拒绝即可）。
fn validate_branch_name(name: &str) -> Result<&str, GitError> {
    let ok = !name.is_empty()
        && !name.contains("..")
        && !name.contains('@')
        && !name.contains(' ')
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+'));
    if !ok {
        return Err(GitError::new(
            "invalid_request",
            format!("invalid branch name: {name}"),
        ));
    }
    Ok(name)
}

/// 运行固定 argv 的变更命令：非零退出即 git_failed（stderr 首行入消息）。
fn run_write(root: &Path, args: &[&str], opts: GitRunOpts) -> Result<Value, GitError> {
    let output = run_git_opts(root, args, opts)?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            format!("git {} timed out", args.first().copied().unwrap_or("")),
        ));
    }
    if output.exit_code == Some(0) {
        return Ok(json!({ "ok": true }));
    }
    let message = if output.stderr.trim().is_empty() {
        // 首行兜底会取到状态标题（"On branch main"），摘要在末行。
        last_nonempty_line(&output.stdout)
    } else {
        first_line(&output.stderr)
    };
    Err(GitError::new("git_failed", message.to_string()))
}

pub fn stage(root: &Path, paths: &[String]) -> Result<Value, GitError> {
    require_paths(paths)?;
    // -A 带 pathspec：把删除（含重命名旧一侧）一并纳入暂存，行为不随 git
    // 版本对 add 的默认语义漂移；有路径限定，不会波及全仓库。
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    for p in paths {
        args.push(validate_rel_path(p)?);
    }
    run_write(root, &args, GIT_LOCAL_WRITE)
}

pub fn unstage(root: &Path, paths: &[String]) -> Result<Value, GitError> {
    require_paths(paths)?;
    let mut args: Vec<&str> = vec!["reset", "--"];
    for p in paths {
        args.push(validate_rel_path(p)?);
    }
    run_write(root, &args, GIT_LOCAL_WRITE)
}

pub fn commit(root: &Path, message: &str) -> Result<Value, GitError> {
    if message.trim().is_empty() {
        return Err(GitError::new(
            "invalid_request",
            "commit message is empty".to_string(),
        ));
    }
    // message 永远是单个 argv 元素：Command 不经 shell，任意文本安全。
    run_write(root, &["commit", "-m", message], GIT_LOCAL_WRITE)
}

pub fn fetch(root: &Path) -> Result<Value, GitError> {
    run_write(root, &["fetch", "origin"], GIT_NETWORK)
}

pub fn pull(root: &Path) -> Result<Value, GitError> {
    run_write(root, &["pull", "--ff-only"], GIT_NETWORK)
}

fn current_branch(root: &Path) -> Result<Option<String>, GitError> {
    let output = run_git_opts(root, &["--no-pager", "branch", "--show-current"], GIT_RO)?;
    if output.exit_code != Some(0) {
        return Err(GitError::new(
            "git_failed",
            first_line(&output.stderr).to_string(),
        ));
    }
    let name = output.stdout.trim().to_string();
    Ok(if name.is_empty() { None } else { Some(name) })
}

fn has_upstream(root: &Path) -> bool {
    run_git_opts(
        root,
        &["--no-pager", "rev-parse", "--abbrev-ref", "@{u}"],
        GIT_RO,
    )
    .map(|output| output.exit_code == Some(0))
    .unwrap_or(false)
}

pub fn push(root: &Path) -> Result<Value, GitError> {
    if has_upstream(root) {
        return run_write(root, &["push"], GIT_NETWORK);
    }
    let branch = current_branch(root)?.ok_or_else(|| {
        GitError::new(
            "git_failed",
            "HEAD is detached; create a branch before pushing".to_string(),
        )
    })?;
    validate_branch_name(&branch)?;
    run_write(
        root,
        &["push", "-u", "origin", branch.as_str()],
        GIT_NETWORK,
    )
}

pub fn branch_create(root: &Path, name: &str, checkout: bool) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    if checkout {
        run_write(root, &["checkout", "-b", name], GIT_LOCAL_WRITE)
    } else {
        run_write(root, &["branch", name], GIT_LOCAL_WRITE)
    }
}

pub fn checkout(root: &Path, name: &str) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    run_write(root, &["checkout", name], GIT_LOCAL_WRITE)
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn stage_then_status_shows_staged_and_commit_succeeds() {
        let Some(root) = testutil::temp_repo_with_commit("w-stage") else {
            return;
        };
        // commit 走 run_git_opts（无 fixture env），仓库级身份兜底保证可提交。
        assert!(testutil::git_cli(&root, &["config", "user.name", "t"]));
        assert!(testutil::git_cli(
            &root,
            &["config", "user.email", "t@example.com"]
        ));
        testutil::write(&root, "f.txt", b"hello\n");

        stage(&root, &paths(&["f.txt"])).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].path, "f.txt");
        assert_eq!(outcome.entries[0].staged, true);

        // 任意含空格/引号的用户文本都是单 argv，不被拆分。
        commit(&root, "feat: add f file with spaces & \"quotes\"").unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.entries.is_empty(), true);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_stages_both_sides_of_a_rename() {
        let Some(root) = testutil::temp_repo_with_commit("w-rename") else {
            return;
        };
        std::fs::rename(root.join("seed.txt"), root.join("renamed.txt")).unwrap();

        stage(&root, &paths(&["seed.txt", "renamed.txt"])).unwrap();
        // 一次 add 同时吃掉删除一半：合并成单条已暂存重命名，不留未暂存残留。
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].path, "renamed.txt");
        assert_eq!(outcome.entries[0].old_path.as_deref(), Some("seed.txt"));
        assert_eq!(outcome.entries[0].status, "renamed");
        assert_eq!(outcome.entries[0].staged, true);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unstage_returns_file_to_working_tree() {
        let Some(root) = testutil::temp_repo_with_commit("w-unstage") else {
            return;
        };
        testutil::write(&root, "seed.txt", b"changed\n");
        stage(&root, &paths(&["seed.txt"])).unwrap();
        assert_eq!(super::super::status(&root).unwrap().entries[0].staged, true);
        unstage(&root, &paths(&["seed.txt"])).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].staged, false);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_unsafe_paths_and_branch_names() {
        let Some(root) = testutil::temp_repo_with_commit("w-unsafe") else {
            return;
        };
        for bad in ["../x", "/etc/passwd", "\\", "a\0b", ""] {
            let error = stage(&root, &paths(&[bad])).unwrap_err();
            assert_eq!(error.code, "path_outside_workspace", "path {bad:?}");
        }
        for bad in ["a b", "-x", "..", "refs/../x", "a@b", "br/", "x.lock"] {
            let error = branch_create(&root, bad, false).unwrap_err();
            assert_eq!(error.code, "invalid_request", "branch {bad:?}");
            let error = checkout(&root, bad).unwrap_err();
            assert_eq!(error.code, "invalid_request", "checkout {bad:?}");
        }
        assert_eq!(commit(&root, "   ").unwrap_err().code, "invalid_request");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_and_unstage_reject_empty_paths() {
        // 空 paths 会让 `git reset --` 变成全量取消暂存、`git add --` 无意义；
        // 进程 adjacent 层不得依赖上游 zod min(1)，必须自行拒绝。
        let Some(root) = testutil::temp_repo_with_commit("w-empty-paths") else {
            return;
        };
        assert_eq!(
            stage(&root, &paths(&[])).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            unstage(&root, &paths(&[])).unwrap_err().code,
            "invalid_request"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn commit_without_staged_changes_surfaces_git_summary() {
        let Some(root) = testutil::temp_repo_with_commit("w-empty-commit") else {
            return;
        };
        let error = commit(&root, "feat: nothing").unwrap_err();
        assert_eq!(error.code, "git_failed");
        assert!(
            error.message.contains("nothing to commit")
                || error.message.contains("no changes added"),
            "message was {:?}",
            error.message
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn checkout_switches_back_and_forth() {
        let Some(root) = testutil::temp_repo_with_commit("w-checkout") else {
            return;
        };
        let main = testutil::default_branch(&root);
        branch_create(&root, "feature", true).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some("feature"));
        checkout(&root, &main).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some(main.as_str()));
        std::fs::remove_dir_all(&root).ok();
    }
}
