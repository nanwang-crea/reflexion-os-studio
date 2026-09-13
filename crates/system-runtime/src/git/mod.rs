//! git 子系统模块：状态/分支（status）、diff 内容读取（diff）、
//! git 进程执行（exec）。对外仅暴露 `service::{status, diff, branches}`。

mod diff;
mod exec;
pub mod service;
mod status;
mod writes;

pub use service::{branches, diff, status};
pub use writes::{branch_create, checkout, commit, fetch, pull, push, stage, unstage};

/// 共享测试助手（service / status 集成测试复用）。
#[cfg(test)]
pub(crate) mod testutil {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::exec::find_git_executable;

    pub(crate) fn temp_workspace(tag: &str) -> PathBuf {
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
    pub(crate) fn git_cli(root: &Path, args: &[&str]) -> bool {
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

    /// 初始化临时仓库（无提交）；git 不可用时返回 None（用例跳过）。
    pub(crate) fn temp_repo(tag: &str) -> Option<PathBuf> {
        let root = temp_workspace(tag);
        if !git_cli(&root, &["init", "-q"]) {
            return None;
        }
        Some(root)
    }

    /// 初始化带一次提交（seed.txt）的临时仓库；git 不可用时返回 None（用例跳过）。
    pub(crate) fn temp_repo_with_commit(tag: &str) -> Option<PathBuf> {
        let root = temp_workspace(tag);
        if !git_cli(&root, &["init", "-q"]) {
            return None;
        }
        write(&root, "seed.txt", b"seed\n");
        assert!(git_cli(&root, &["add", "."]));
        assert!(git_cli(&root, &["commit", "-q", "-m", "init"]));
        Some(root)
    }

    /// 当前 HEAD 分支名（init 默认分支受用户配置影响，跨机器断言用）。
    pub(crate) fn default_branch(root: &Path) -> String {
        let executable = find_git_executable().expect("git executable not found");
        let output = Command::new(executable)
            .current_dir(root)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .expect("spawn git symbolic-ref");
        assert!(output.status.success(), "git symbolic-ref failed");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    pub(crate) fn write(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}
