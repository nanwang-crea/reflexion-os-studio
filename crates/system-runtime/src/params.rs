//! 工具方法请求参数：JSON-RPC params 的 Deserialize 定义（camelCase、未知字段拒绝）。
use serde::Deserialize;

/// 带授权引用的单路径写类操作（delete / mkdir）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantPathParams {
    pub workspace_root: String,
    pub path: String,
    pub grant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadParams {
    pub workspace_root: String,
    pub path: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    pub workspace_root: String,
    pub path: String,
    pub recursive: Option<bool>,
    /// 分页起点：默认 0；非法负数由调用方归一化，服务端不做拒绝。
    pub offset: Option<usize>,
    /// 单次返回条数上限：默认 DEFAULT_LIST_LIMIT，服务端再按 MAX_LIST_LIMIT 收敛。
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobParams {
    pub workspace_root: String,
    pub pattern: String,
    /// 分页起点：默认 0；与 file.list 同构。
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrepParams {
    pub workspace_root: String,
    /// 字面子串（非正则）；大小写策略由 ignore_case 控制。
    pub text: String,
    /// 仅扫描命中该 glob 的文件，如 `*.rs`。
    pub glob: Option<String>,
    pub ignore_case: Option<bool>,
    /// 命中行前后附带的上下文行数（0-5），缺省 0。
    pub context: Option<usize>,
    pub max_results: Option<usize>,
}

/// 写操作授权来源：agent = 审批网关签发的凭据（默认）；ui = 用户直接动作，
/// 无审批概念、免凭据，但先读后写（revision）的丢更新保护仍然生效。
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperationSource {
    Agent,
    Ui,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteParams {
    pub workspace_root: String,
    pub path: String,
    pub content: String,
    /// 覆盖已存在文件必填：一次 file.read 完整读取发放的 revision 凭据
    /// （mtime + size + sha256）；新建文件可缺省。
    pub revision: Option<crate::files::Revision>,
    /// agent 来源必填且必须通过 require_grant；ui 来源忽略。
    pub grant: Option<String>,
    #[serde(default)]
    pub source: Option<OperationSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditParams {
    pub workspace_root: String,
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    /// 要求 oldText 恰好出现的次数（默认 1），不匹配则拒绝写入。
    pub expected_count: Option<usize>,
    /// 必填：一次读取/写入发放的 revision 凭据（mtime+size+sha256），
    /// 编辑侧用于先读后写强制与陈旧检测（任一字段不一致即拒绝）。
    pub revision: Option<crate::files::Revision>,
    pub grant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveParams {
    pub workspace_root: String,
    pub from: String,
    pub to: String,
    pub grant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellParams {
    pub workspace_root: String,
    pub command: String,
    pub cwd: Option<String>,
    pub grant: String,
    pub timeout_ms: Option<u64>,
    pub allow_network: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStatusParams {
    pub workspace_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitBranchesParams {
    pub workspace_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffParams {
    pub workspace_root: String,
    pub path: String,
    pub staged: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitPathsParams {
    pub workspace_root: String,
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitParams {
    pub workspace_root: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRootParams {
    pub workspace_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitBranchCreateParams {
    pub workspace_root: String,
    pub name: String,
    pub checkout: Option<bool>,
    pub start_ref: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutParams {
    pub workspace_root: String,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitLogParams {
    pub workspace_root: String,
    /// 分页起点：默认 0；负数在 TS 侧已归一化，usize 天然拒绝。
    pub skip: Option<usize>,
    /// 单页条数：默认 50，服务端按 200 收敛（见 handlers_git::handle_git_log）。
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitFilesParams {
    pub workspace_root: String,
    /// 完整或短 hash：hex 形态（4–64 位）在 handler 主线程校验后放行。
    pub hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitDiffParams {
    pub workspace_root: String,
    pub hash: String,
    /// workspace 相对路径：边界校验在 git::commit_diff 内完成。
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRemoteAddParams {
    pub workspace_root: String,
    pub name: String,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRemoteRemoveParams {
    pub workspace_root: String,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_params_allow_network_defaults_to_none() {
        let params: ShellParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "command": "echo hi",
            "grant": "g",
        }))
        .unwrap();
        assert_eq!(params.allow_network, None);
    }

    #[test]
    fn shell_params_allow_network_parses_true() {
        let params: ShellParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "command": "echo hi",
            "grant": "g",
            "allowNetwork": true,
        }))
        .unwrap();
        assert_eq!(params.allow_network, Some(true));
    }

    #[test]
    fn git_branch_create_start_ref_is_optional_camel_case() {
        let without: GitBranchCreateParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "name": "feat",
        }))
        .unwrap();
        assert_eq!(without.start_ref, None);
        let with: GitBranchCreateParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "name": "feat",
            "checkout": true,
            "startRef": "deadbeef",
        }))
        .unwrap();
        assert_eq!(with.start_ref.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn git_log_params_pagination_options_and_reject_unknown() {
        let bare: GitLogParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
        }))
        .unwrap();
        assert_eq!(bare.skip, None);
        assert_eq!(bare.limit, None);
        let paged: GitLogParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "skip": 50,
            "limit": 25,
        }))
        .unwrap();
        assert_eq!((paged.skip, paged.limit), (Some(50), Some(25)));
        let unknown = serde_json::from_value::<GitLogParams>(serde_json::json!({
            "workspaceRoot": "/w",
            "hash": "deadbeef",
        }));
        assert!(unknown.is_err());
    }

    #[test]
    fn git_commit_history_params_require_hash_and_path() {
        let files: GitCommitFilesParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "hash": "deadbeef",
        }))
        .unwrap();
        assert_eq!(files.hash, "deadbeef");
        let diff: GitCommitDiffParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "hash": "abc1234",
            "path": "src/main.rs",
        }))
        .unwrap();
        assert_eq!(
            (diff.hash.as_str(), diff.path.as_str()),
            ("abc1234", "src/main.rs")
        );
        // hash 缺失 / 未知字段都拒绝。
        assert!(
            serde_json::from_value::<GitCommitFilesParams>(serde_json::json!({
                "workspaceRoot": "/w",
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<GitCommitDiffParams>(serde_json::json!({
                "workspaceRoot": "/w",
                "hash": "abc1234",
                "path": "f",
                "staged": true,
            }))
            .is_err()
        );
    }

    #[test]
    fn git_remote_params_require_fields_and_reject_unknown() {
        let add: GitRemoteAddParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "name": "origin",
            "url": "git@github.com:o/r.git",
        }))
        .unwrap();
        assert_eq!(
            (add.name.as_str(), add.url.as_str()),
            ("origin", "git@github.com:o/r.git")
        );
        let remove: GitRemoteRemoveParams = serde_json::from_value(serde_json::json!({
            "workspaceRoot": "/w",
            "name": "origin",
        }))
        .unwrap();
        assert_eq!(remove.name, "origin");
        assert!(
            serde_json::from_value::<GitRemoteAddParams>(serde_json::json!({
                "workspaceRoot": "/w",
                "name": "origin",
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<GitRemoteRemoveParams>(serde_json::json!({
                "workspaceRoot": "/w",
                "name": "origin",
                "url": "x",
            }))
            .is_err()
        );
    }
}
