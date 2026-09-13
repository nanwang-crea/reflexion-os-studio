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
/// remotes.rs 复用同一规则校验 remote 名。
pub(super) fn validate_branch_name(name: &str) -> Result<&str, GitError> {
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

/// 十六进制 revision 形态（4–64 位 hex）：validate_revref 的快速路径与
/// 只读 handler（commit_files / commit_diff）主线程拒绝共用同一规则，避免两处漂移。
pub fn is_hex_rev(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// 检出/起点接受：本地分支名、十六进制 commit、`remote/branch`（形态安全，
/// 不校验 ref 是否存在，交给 git 报错）。hex 形态（4–64 位）直通过，
/// 否则回落到分支名白名单（`HEAD` 为纯字母 → 按分支名放行；switch 会拒绝
/// HEAD 这种符号 ref——"a branch is expected"——但不触碰工作树，无害）。
fn validate_revref(s: &str) -> Result<(), GitError> {
    if is_hex_rev(s) {
        return Ok(());
    }
    validate_branch_name(s).map(|_| ())
}

/// 运行固定 argv 的变更命令：非零退出即 git_failed（stderr 首行入消息）。
/// remotes.rs 的 remote add/remove 共用同一失败语义。
pub(super) fn run_write(root: &Path, args: &[&str], opts: GitRunOpts) -> Result<Value, GitError> {
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
    Err(GitError::new("git_failed", message))
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
        return Err(GitError::new("git_failed", first_line(&output.stderr)));
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

pub fn branch_create(
    root: &Path,
    name: &str,
    checkout: bool,
    start: Option<&str>,
) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    let mut args: Vec<&str> = Vec::new();
    if checkout {
        // switch -c 只接受 ref/起点，不存在 checkout 的 pathspec 回退歧义。
        args.extend(["switch", "-c", name]);
    } else {
        args.extend(["branch", name]);
    }
    if let Some(s) = start {
        validate_revref(s)?;
        args.push(s);
    }
    run_write(root, &args, GIT_LOCAL_WRITE)
}

/// 本地分支是否恰好叫这个名字（refs/heads/<name> 存在）。供 hex 形态名
/// （`2024`/`beef` 这类合法且常见的工单号分支）判别：先按分支检出，而非 detach。
fn local_branch_exists(root: &Path, name: &str) -> Result<bool, GitError> {
    let revision = format!("refs/heads/{name}");
    let output = run_git_opts(
        root,
        &["--no-pager", "rev-parse", "--verify", "--quiet", &revision],
        GIT_RO,
    )?;
    Ok(output.exit_code == Some(0))
}

/// 导航到分支/提交（`git.branch_switch` 的执行体；刻意命名 switch_to，
/// 防止后人重引入 `git checkout`）。**只用 ref-only 的 `git switch`**：
/// `git checkout` 对非 ref 的 revref 会回退为 pathspec 模式——仓库里恰有
/// 同名被跟踪文件时（如 `v1.2`）会静默丢弃该文件的磁盘修改（数据丢失攻击面）。
/// hex 形态先查 `refs/heads/<name>`：分支真实存在（`beef`/`2024` 等合法
/// 工单号名）→ 普通 `switch`；不存在 → `switch --detach`（switch 拒绝裸
/// commit）。非 hex → `switch <name>`，不是 ref 即 fatal "invalid reference"
/// 报错退出，工作树不受影响。
pub fn switch_to(root: &Path, name: &str) -> Result<Value, GitError> {
    validate_revref(name)?;
    if is_hex_rev(name) && !local_branch_exists(root, name)? {
        return run_write(root, &["switch", "--detach", name], GIT_LOCAL_WRITE);
    }
    run_write(root, &["switch", name], GIT_LOCAL_WRITE)
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
            let error = branch_create(&root, bad, false, None).unwrap_err();
            assert_eq!(error.code, "invalid_request", "branch {bad:?}");
            let error = switch_to(&root, bad).unwrap_err();
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
        branch_create(&root, "feature", true, None).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some("feature"));
        switch_to(&root, &main).unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some(main.as_str()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn validate_revref_accepts_revref_shapes_and_rejects_injection() {
        // hex 形态（4–64 位）直通过；大小写均可。
        for ok in [
            "0123",
            "deadbeef",
            "DEADBEEF",
            &"f".repeat(64),
            // 非 hex 回落分支名白名单。
            "main",
            "a/b",
            "origin/main",
            // 纯字母 → 按分支名放行：switch 会把 HEAD 判为符号 ref 拒绝
            // （"a branch is expected"），但不触碰工作树，无害；
            // 历史面板"切出的提交"用完整 hex 而非 HEAD。
            "HEAD",
        ] {
            assert!(validate_revref(ok).is_ok(), "revref {ok:?}");
        }
        for bad in ["", "-x", "a b", "x;rm -rf /", "a@b", "br/", "..", "x.lock"] {
            let error = validate_revref(bad).unwrap_err();
            assert_eq!(error.code, "invalid_request", "revref {bad:?}");
        }
    }

    #[test]
    fn checkout_accepts_hex_rev_and_detaches_head() {
        let Some(root) = testutil::temp_repo_with_commit("w-checkout-hex") else {
            return;
        };
        let hash = head_hash(&root);
        switch_to(&root, &hash).unwrap();
        // detached HEAD：branch --show-current 为空 → status.branch None。
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch, None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn switch_to_hex_shaped_branch_name_lands_on_branch_not_detached() {
        // 攻击形态之外的日常形态：分支名恰好长得像 hex（`beef`/`2024` 这类
        // 合法且常见的工单号名）必须按分支切换，而不是被误判成 commit detach。
        let Some(root) = testutil::temp_repo_with_commit("w-hex-branch") else {
            return;
        };
        branch_create(&root, "beef", false, None).unwrap();
        switch_to(&root, "beef").unwrap();
        let outcome = super::super::status(&root).unwrap();
        assert_eq!(outcome.branch.as_deref(), Some("beef"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn fetch_failure_message_never_echoes_url_credentials() {
        // secret 纪律（AGENTS §4）：fetch/push/pull 失败回显的 remote URL 即使
        // 带凭据也不得进 git_failed 消息。127.0.0.1:1 连接拒绝：无真实网络、
        // 快速确定；断言取"消息不含凭据"这一不变量（新旧 git 行为差异下都成立）。
        let Some(root) = testutil::temp_repo_with_commit("w-scrub") else {
            return;
        };
        super::super::remote_add(&root, "origin", "https://tok@127.0.0.1:1/x.git").unwrap();
        let error = fetch(&root).unwrap_err();
        assert_eq!(error.code, "git_failed");
        assert!(
            !error.message.contains("tok@"),
            "message leaked credentials: {:?}",
            error.message
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn checkout_rejects_ref_collision_with_tracked_file_and_preserves_edits() {
        // 攻击形态回归：`git checkout v1.2` 在 v1.2 非 ref 时回退 pathspec
        // 模式，会静默丢弃同名被跟踪文件的磁盘修改。switch 为 ref-only：
        // 必须报错（fatal: invalid reference）且磁盘修改原样保留。
        let Some(root) = testutil::temp_repo_with_commit("w-checkout-pathspec") else {
            return;
        };
        testutil::write(&root, "v1.2", b"tagged\n");
        assert!(testutil::git_cli(&root, &["add", "."]));
        assert!(testutil::git_cli(
            &root,
            &["commit", "-q", "-m", "add v1.2"]
        ));
        testutil::write(&root, "v1.2", b"precious local edits\n");

        let error = switch_to(&root, "v1.2").unwrap_err();
        assert_eq!(error.code, "git_failed");
        assert!(
            error.message.contains("invalid reference"),
            "message was {:?}",
            error.message
        );
        assert_eq!(
            std::fs::read_to_string(root.join("v1.2")).unwrap(),
            "precious local edits\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn branch_create_from_start_rev_and_rejects_unsafe_start() {
        let Some(root) = testutil::temp_repo_with_commit("w-branch-start") else {
            return;
        };
        let hash = head_hash(&root);
        branch_create(&root, "from-hex", false, Some(&hash)).unwrap();
        assert_eq!(rev_parse(&root, "from-hex"), hash);
        // 非检出式创建：HEAD 仍在原分支上。
        assert_eq!(
            super::super::status(&root).unwrap().branch,
            Some(testutil::default_branch(&root))
        );
        for bad in ["a b", "-x", "x;rm"] {
            let error = branch_create(&root, "ok-name", false, Some(bad)).unwrap_err();
            assert_eq!(error.code, "invalid_request", "start {bad:?}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    fn head_hash(root: &std::path::Path) -> String {
        rev_parse(root, "HEAD")
    }

    fn rev_parse(root: &std::path::Path, rev: &str) -> String {
        let executable = super::super::exec::find_git_executable().expect("git executable");
        let output = std::process::Command::new(executable)
            .current_dir(root)
            .args(["rev-parse", rev])
            .output()
            .expect("spawn git rev-parse");
        assert!(output.status.success(), "git rev-parse {rev} failed");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}
