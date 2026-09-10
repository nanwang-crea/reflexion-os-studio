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
    pub max_results: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteParams {
    pub workspace_root: String,
    pub path: String,
    pub content: String,
    /// 覆盖已存在文件必填：一次 file.read 返回的 mtime 凭据；新建文件可缺省。
    pub read_token: Option<u64>,
    pub grant: String,
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
    /// 必填：一次 file.read 返回的 mtime 凭据，用于先读后写强制与陈旧检测。
    pub read_token: Option<u64>,
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
