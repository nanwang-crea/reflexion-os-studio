//! 远程（remote）管理：list / add / remove。list 只读（GIT_RO）；
//! add/remove 仅改本地 config 与 refs，不触网（GIT_LOCAL_WRITE）。
//! 回显 URL 一律经 mask_remote_url 剥凭据；非法 name/url 在 spawn 前拒绝。

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::exec::{first_line, run_git, GIT_LOCAL_WRITE};
use super::service::GitError;
use super::writes::{run_write, validate_branch_name};

fn invalid(message: String) -> GitError {
    GitError::new("invalid_request", message)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// 已剥凭据（见 mask_remote_url）。
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotesOutcome {
    pub repo: bool,
    pub remotes: Vec<RemoteInfo>,
}

/// `git remote -v` 只取 (fetch) 行（(push) 是同名 remote 的重复项）；
/// 非仓库 → repo=false + 空列表。
pub fn list(workspace_root: &Path) -> Result<RemotesOutcome, GitError> {
    let output = run_git(workspace_root, &["--no-pager", "remote", "-v"])?;
    if output.timed_out {
        return Err(GitError::new(
            "git_failed",
            "git remote timed out".to_string(),
        ));
    }
    if output.exit_code != Some(0) {
        if super::status::is_not_a_repo(&output) {
            return Ok(RemotesOutcome {
                repo: false,
                remotes: Vec::new(),
            });
        }
        return Err(GitError::new("git_failed", first_line(&output.stderr)));
    }
    let mut remotes = Vec::new();
    for line in output.stdout.lines() {
        // 行形态 `<name>\t<url> (fetch)`；旧版 git 用连续空格分隔，
        // 按首段空白切分：name 为首段，url 为其余（保留 url 内罕见空格）。
        let Some(rest) = line.strip_suffix(" (fetch)") else {
            continue;
        };
        let Some(idx) = rest.find(char::is_whitespace) else {
            continue;
        };
        let name = &rest[..idx];
        let url = rest[idx..].trim_start();
        if name.is_empty() || url.is_empty() {
            continue;
        }
        remotes.push(RemoteInfo {
            name: name.to_string(),
            url: mask_remote_url(url),
        });
    }
    Ok(RemotesOutcome {
        repo: true,
        remotes,
    })
}

/// 凭据剥离规则（保守白名单式遮蔽，其余原样）：
/// - `scheme://` 形态且 authority 带 userinfo 时，满足任一即把整个 userinfo
///   替换为 `***`：scheme 为 http/https（GitHub 惯例把裸 token 放 user 段，
///   `https://TOKEN@github.com/…` 无冒号也必须遮蔽），或 userinfo 含 `:`
///   （任意 scheme 带密码形态）。
/// - username 恰为 `git`（`ssh://git@host/…`、`git@host:path`）不是机密，原样保留。
/// - scp 形态 `user@host:path` 无 scheme、协议上无法携带密码，原样返回。
fn mask_remote_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let scheme = &url[..scheme_end];
    let rest = &url[scheme_end + 3..];
    let authority_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_len];
    // LAST-@ 切分：密码本身含 '@' 时整个 userinfo 遮蔽（宁多遮不漏遮）。
    let Some(at) = authority.rfind('@') else {
        return url.to_string();
    };
    let userinfo = &authority[..at];
    let is_http = scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https");
    if !userinfo.is_empty() && userinfo != "git" && (is_http || userinfo.contains(':')) {
        format!("{scheme}://***@{}", &rest[at + 1..])
    } else {
        url.to_string()
    }
}

/// remote add：name 走分支名白名单，url 走 scheme 白名单（validate_remote_url），
/// 全部在 spawn 前完成；git 侧同名冲突等失败走 git_failed。
pub fn add(workspace_root: &Path, name: &str, url: &str) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    validate_remote_url(url)?;
    run_write(
        workspace_root,
        &["remote", "add", name, url],
        GIT_LOCAL_WRITE,
    )
}

pub fn remove(workspace_root: &Path, name: &str) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    run_write(workspace_root, &["remote", "remove", name], GIT_LOCAL_WRITE)
}

const REMOTE_URL_SCHEMES: [&str; 5] = ["https://", "http://", "ssh://", "git://", "file://"];

/// URL 白名单（进程边界层的防御纵深，git 自身的 ext:: 传输是真实攻击面）：
/// 拒绝任何空白/控制字符与前导 '-'（防 argv 注入与选项走私），scheme 限
/// https/http/ssh/git/file，或 scp 形态 `git@host:path`（恰一个 ':' 且两侧非空）。
fn validate_remote_url(url: &str) -> Result<&str, GitError> {
    if url.is_empty()
        || url.starts_with('-')
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid(format!("invalid remote url: {url}")));
    }
    if let Some(target) = REMOTE_URL_SCHEMES.iter().find_map(|s| url.strip_prefix(s)) {
        if !target.is_empty() {
            return Ok(url);
        }
        return Err(invalid(format!("invalid remote url: {url}")));
    }
    if let Some(host_and_path) = url.strip_prefix("git@") {
        let exactly_one_colon = match host_and_path.find(':') {
            Some(colon) => {
                colon > 0
                    && colon + 1 < host_and_path.len()
                    && host_and_path.rfind(':') == Some(colon)
            }
            None => false,
        };
        if exactly_one_colon {
            return Ok(url);
        }
    }
    Err(invalid(format!("invalid remote url: {url}")))
}

#[cfg(test)]
mod tests {
    use super::super::testutil;
    use super::*;

    #[test]
    fn mask_remote_url_covers_all_four_credential_shapes() {
        // http(s) 带密码 / 裸 token 放 user 段：一律遮蔽整个 userinfo。
        assert_eq!(
            mask_remote_url("https://user:pw@host.invalid/x.git"),
            "https://***@host.invalid/x.git"
        );
        assert_eq!(
            mask_remote_url("https://TOKEN@github.com/x.git"),
            "https://***@github.com/x.git"
        );
        // 密码含 '@'：按最后一个 '@' 切 userinfo/host，整段遮蔽。
        assert_eq!(
            mask_remote_url("https://user:pa@ss@host"),
            "https://***@host"
        );
        // 用户名 git 非机密：scp 形态与 ssh://git@ 原样保留。
        assert_eq!(
            mask_remote_url("git@github.com:x/y.git"),
            "git@github.com:x/y.git"
        );
        assert_eq!(
            mask_remote_url("ssh://git@github.com/x/y.git"),
            "ssh://git@github.com/x/y.git"
        );
        // 其余形态不受影响；非 http 带密码防御性遮蔽。
        assert_eq!(
            mask_remote_url("file:///tmp/origin.git"),
            "file:///tmp/origin.git"
        );
        assert_eq!(mask_remote_url("ssh://alice:pw@host/x"), "ssh://***@host/x");
    }

    #[test]
    fn add_list_remove_roundtrip_with_file_remote() {
        let Some(root) = testutil::temp_repo_with_commit("r-roundtrip") else {
            return;
        };
        let origin = testutil::temp_workspace("r-roundtrip-origin");
        let url = format!("file://{}/none.git", origin.display());
        add(&root, "origin", &url).unwrap();
        let outcome = list(&root).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.remotes.len(), 1);
        assert_eq!(outcome.remotes[0].name, "origin");
        // file:// 干净 URL 原样回显（不被误遮蔽）。
        assert_eq!(outcome.remotes[0].url, url);

        remove(&root, "origin").unwrap();
        let outcome = list(&root).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.remotes.is_empty(), true);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&origin).ok();
    }

    #[test]
    fn list_masks_credentials_through_real_git() {
        let Some(root) = testutil::temp_repo_with_commit("r-mask") else {
            return;
        };
        add(&root, "tok", "https://TOKEN@github.com/x.git").unwrap();
        add(&root, "scpremot", "git@github.com:o/r.git").unwrap();
        let outcome = list(&root).unwrap();
        assert_eq!(outcome.remotes.len(), 2);
        assert_eq!(
            outcome
                .remotes
                .iter()
                .find(|r| r.name == "tok")
                .unwrap()
                .url,
            "https://***@github.com/x.git"
        );
        assert_eq!(
            outcome
                .remotes
                .iter()
                .find(|r| r.name == "scpremot")
                .unwrap()
                .url,
            "git@github.com:o/r.git"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn add_rejects_illegal_urls_and_names_before_spawn() {
        let Some(root) = testutil::temp_repo_with_commit("r-unsafe") else {
            return;
        };
        for bad in [
            "ext::sh -c touch% /tmp/pwned", // 危险传输 + 空格
            "-b",                           // 前导 '-'（argv 选项走私）
            "https://host.invalid/a b.git", // 空格
            "garbage",                      // 无合法 scheme
            "",                             // 空
            "file://",                      // scheme 后无目标
            "git@host",                     // scp 形态缺 ':' 路径分隔
            "git@host:a:b",                 // scp 形态多余 ':'
        ] {
            let error = add(&root, "origin", bad).unwrap_err();
            assert_eq!(error.code, "invalid_request", "url {bad:?}");
        }
        assert!(!std::path::Path::new("/tmp/pwned").exists());
        // 非法 URL 全部在 spawn 前拒绝：remote 未落库。
        assert!(list(&root).unwrap().remotes.is_empty());
        for bad in ["a b", "-x", ""] {
            let error = add(&root, bad, "file:///tmp/ok.git").unwrap_err();
            assert_eq!(error.code, "invalid_request", "name {bad:?}");
            let error = remove(&root, bad).unwrap_err();
            assert_eq!(error.code, "invalid_request", "remove name {bad:?}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_non_repo_reports_repo_false() {
        let root = testutil::temp_workspace("r-non-repo");
        if super::super::exec::find_git_executable().is_none() {
            eprintln!("skip: git executable not found");
            return;
        }
        let outcome = list(&root).unwrap();
        assert_eq!(outcome.repo, false);
        assert!(outcome.remotes.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
