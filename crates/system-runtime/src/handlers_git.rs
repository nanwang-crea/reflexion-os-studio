//! Git 方法执行：status / diff / branches / log / commit_files / commit_diff /
//! remotes 只读查询与 stage / commit / fetch / push / pull / branch / remote 写操作。
//! 参数解析与 workspace 边界检查在主线程完成，git 进程在异步工作线程执行后
//! emit，避免大仓库或慢网络阻塞协议主循环。

use serde_json::{json, Value};

use crate::git;
use crate::params::{
    GitBranchCreateParams, GitBranchesParams, GitCheckoutParams, GitCommitDiffParams,
    GitCommitFilesParams, GitCommitParams, GitDiffParams, GitLogParams, GitPathsParams,
    GitRemoteAddParams, GitRemoteRemoveParams, GitRootParams, GitStatusParams,
};
use crate::protocol::{emit, error_response, ok_response, workspace_root, OpError};

/// git 只读查询（status/diff）：异步执行避免大仓库阻塞主循环，
/// 结果与错误照常 emit；进程级超时与收集在 git 模块内完成。
pub fn handle_git_status(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitStatusParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::status(&root) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_diff(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitDiffParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let path = params.path;
    let staged = params.staged.unwrap_or(false);
    std::thread::spawn(move || match git::diff(&root, &path, staged) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// git 本地分支只读查询（新建对话项目/分支选择用）；异步执行避免阻塞主循环。
pub fn handle_git_branches(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitBranchesParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::branches(&root) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// 提交历史分页（默认页 50；上限 200 服务端收敛，防客户端拉大页拖垮 sidecar）。
pub fn handle_git_log(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitLogParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let skip = params.skip.unwrap_or(0);
    // 默认页 50；limit 防御性封顶 200：UI 分页步长远小于该值，超限静默收敛而非报错。
    let limit = params.limit.unwrap_or(50).min(200);
    std::thread::spawn(move || match git::log(&root, skip, limit) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// 单 commit 相对父提交的改动文件列表。hash 在主线程按与写侧 validate_revref
/// 同一 hex 规则预校验（spawn 前拒绝），路径边界在 git 模块内完成。
pub fn handle_git_commit_files(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitCommitFilesParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    if !git::is_hex_rev(&params.hash) {
        return Err(OpError::new(
            "invalid_request",
            format!("invalid commit hash: {}", params.hash),
        ));
    }
    let hash = params.hash;
    std::thread::spawn(move || match git::commit_files(&root, &hash) {
        // 包一层 files 字段：与 git.status 等响应同为对象形态（TS 侧 r.files 消费）。
        Ok(files) => emit(ok_response(
            id,
            json!({ "files": serde_json::to_value(&files).unwrap_or_else(|_| json!([])) }),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// 单 commit 单文件两侧内容（历史面板 diff 预览）。hash 校验同 commit_files；
/// path 的 workspace 边界校验在 git::commit_diff 内完成。
pub fn handle_git_commit_diff(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitCommitDiffParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    if !git::is_hex_rev(&params.hash) {
        return Err(OpError::new(
            "invalid_request",
            format!("invalid commit hash: {}", params.hash),
        ));
    }
    let hash = params.hash;
    let path = params.path;
    std::thread::spawn(move || match git::commit_diff(&root, &hash, &path) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// 以下 git 写命令同构：解析参数与 workspace 边界在主线程完成，
/// git 进程在异步线程执行后 emit（UI 直接动作免 grant，来源由 Runtime 声明；
/// argv 固定拼装与路径/分支名校验在 git::writes 内完成）。
pub fn handle_git_stage(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitPathsParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let paths = params.paths;
    std::thread::spawn(move || match git::stage(&root, &paths) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_unstage(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitPathsParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let paths = params.paths;
    std::thread::spawn(move || match git::unstage(&root, &paths) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_commit(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitCommitParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let message = params.message;
    std::thread::spawn(move || match git::commit(&root, &message) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_fetch(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRootParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::fetch(&root) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_pull(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRootParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::pull(&root) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_push(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRootParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::push(&root) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_branch_create(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitBranchCreateParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let name = params.name;
    let checkout = params.checkout.unwrap_or(false);
    let start = params.start_ref;
    std::thread::spawn(move || {
        match git::branch_create(&root, &name, checkout, start.as_deref()) {
            Ok(outcome) => emit(ok_response(id, outcome)),
            Err(error) => emit(error_response(
                id,
                -32000,
                &error.message,
                Some(json!({ "code": error.code })),
            )),
        }
    });
    Ok((Value::Null, false))
}

pub fn handle_git_branch_switch(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitCheckoutParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let name = params.name;
    std::thread::spawn(move || match git::switch_to(&root, &name) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// 远程列表只读查询（GIT_RO 档）；URL 出边界前已在 git::remotes_list 剥凭据。
pub fn handle_git_remotes(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRootParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    std::thread::spawn(move || match git::remotes_list(&root) {
        Ok(outcome) => emit(ok_response(
            id,
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        )),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

/// remote add/remove：本地 config 写（不触网），name/url 校验在 git::remotes 内
/// spawn 前完成，失败照常 git_failed / invalid_request 经 error data 透出。
pub fn handle_git_remote_add(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRemoteAddParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let name = params.name;
    let url = params.url;
    std::thread::spawn(move || match git::remote_add(&root, &name, &url) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}

pub fn handle_git_remote_remove(id: Value, params: Value) -> Result<(Value, bool), OpError> {
    let params: GitRemoteRemoveParams = serde_json::from_value(params)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))?;
    let root = workspace_root(&params.workspace_root)?;
    let name = params.name;
    std::thread::spawn(move || match git::remote_remove(&root, &name) {
        Ok(outcome) => emit(ok_response(id, outcome)),
        Err(error) => emit(error_response(
            id,
            -32000,
            &error.message,
            Some(json!({ "code": error.code })),
        )),
    });
    Ok((Value::Null, false))
}
