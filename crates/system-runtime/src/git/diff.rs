//! 单文件 diff 两侧内容读取：git 对象（`git show`）+ 工作树文件。
//! checkout 侧 EOL 归一化（autocrlf / eol=crlf）在此处理，避免 Windows
//! 场景把未变更文件逐行误报为已修改。

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::paths::resolve_in_workspace;

use super::exec::{first_line, run_git};
use super::service::GitError;

/// diff 文本最大返回字节数（超出截断并标记）。
pub(super) const MAX_DIFF_BYTES: usize = 512 * 1024;

/// 单侧内容：git 对象内容或工作树文件内容（上限 MAX_DIFF_BYTES）。
pub(super) struct BlobContent {
    pub text: String,
    pub truncated: bool,
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

/// 单文件 diff 两侧内容：staged=false 为 索引 → 工作树，staged=true 为
/// HEAD → 索引。original/modified 直接取自 git 对象与磁盘文件，不经
/// diff 文本反推（反推对新增/删除/大文件/二进制均有不可修的失真）。
/// 路径不在对应树中（新增/删除）按空串处理；非仓库返回 repo=false。
pub(super) fn diff(
    workspace_root: &Path,
    relative: &str,
    staged: bool,
) -> Result<DiffOutcome, GitError> {
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
