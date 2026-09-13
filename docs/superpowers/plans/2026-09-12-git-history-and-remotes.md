# Git 提交历史 + 远程管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤用 `- [ ]` 勾选。

**Goal:** 增加仓库级提交历史（只读浏览 + checkout/建分支导航）与远程管理（remote 增删列表、远程分支检出、发布当前分支）。

**Architecture:** Rust `git/` 扩 6 只读 + 2 写命令（log/commit_files/commit_diff/remotes/remote_add/remote_remove + branch_switch 接受 hex、branch_create 接受 startRef）；`git.handlers` 拆到独立 `handlers_git.rs`；runtime 转发 + 串行队列复用；前端新增 GitHistory tab 与 BranchPicker 远程/远端分区。commit_diff 走既有 `openDiff(source:'chat', before/after)` 通道，零改查看器。

**Tech Stack:** Rust、TypeScript strict、React 19、zod、node:test。

**Spec:** `docs/superpowers/specs/2026-09-12-git-history-and-remotes-design.md`

**约定：** 不 commit；改 TS/Rust 后跑门禁；真实二进制 e2e 需 `REFLEXION_SYSTEM_RUNTIME_BIN=$PWD/../../crates/target/debug/reflexion-system-runtime`；Rust 改后 `cargo build` 重建 debug 二进制；prettier 仅针对本次文件。

---

## 子批 H：提交历史

### Task H1: contracts

**Files:** Modify `packages/contracts/src/commands.ts`

- [ ] 在 `workspace.git_branch_switch` 后新增：

```ts
  // ---------- Git 提交历史（只读浏览 + 导航；hash 一律十六进制） ----------
  'workspace.git_log': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      skip: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      repo: z.boolean(),
      commits: z.array(
        z.object({
          hash: z.string(),
          shortHash: z.string(),
          timestampMs: z.number().int().nonnegative(),
          authorName: z.string(),
          isMerge: z.boolean(),
          subject: z.string(),
        }),
      ),
      hasMore: z.boolean(),
    }),
  },
  'workspace.git_commit_files': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
    }),
    result: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          oldPath: z.string().optional(),
          status: GitChangeStatusSchema,
        }),
      ),
    }),
  },
  'workspace.git_commit_diff': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      hash: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
      path: z.string().min(1),
    }),
    // original = 该文件在 <hash>^ 的内容（root/新增→空），modified = <hash>。
    result: z.object({
      original: z.string(),
      modified: z.string(),
      binary: z.boolean(),
      truncated: z.boolean(),
    }),
  },
```

`workspace.git_branch_create` params 增 `startRef: z.string().min(1).optional()`（基于 commit 或 `remote/branch` 建分支）。

- [ ] `pnpm build:packages` 通过。

### Task H2: Rust git::log（log + commit_files 解析）

**Files:** Create `crates/system-runtime/src/git/log.rs`；Modify `git/mod.rs`

- [ ] log.rs：

```rust
//! 提交历史读取：git log 元信息解析 + 单 commit 改动文件（name-status -z）。
//! 只读；hash 由上层预校验为十六进制，仍走 --no-pager 与超时档。
use std::path::Path;
use serde::Serialize;
use super::exec::{first_line, run_git};
use super::service::GitError;

/// 空树 OID：root commit（无父）diff 的左端，规避 <hash>^ 不存在。
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub short_hash: String,
    pub timestamp_ms: u64,
    pub author_name: String,
    pub is_merge: bool,
    pub subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOutcome {
    pub repo: bool,
    pub commits: Vec<LogEntry>,
    pub has_more: bool,
}

/// fields 用 %x1f（单元分隔符）连接，单条记录内 subject 若含 %x1f 概率极低的
/// 兜底：split 取固定前 5 段 + 其余并入 subject。记录间用 \n（log 默认换行）。
pub fn log(root: &Path, skip: usize, limit: usize) -> Result<LogOutcome, GitError> {
    let fetch = limit + 1; // 多取一条判 hasMore
    let format = "%H\x1f%h\x1f%at\x1f%an\x1f%P\x1f%s";
    let output = run_git(
        root,
        &[
            "--no-pager",
            "log",
            &format!("--pretty=format:{format}"),
            &format!("--skip={skip}"),
            &format!("--max-count={fetch}"),
        ],
    )?;
    // 不过滤 merge：isMerge 由 %P 父数判，需展示。
    if output.timed_out {
        return Err(GitError::new("git_failed", "git log timed out".to_string()));
    }
    match output.exit_code {
        Some(0) => {}
        _ if super::status::is_not_a_repo(&output) => {
            return Ok(LogOutcome { repo: false, commits: Vec::new(), has_more: false });
        }
        // 空仓库：log 报 "does not have any commits yet"（128）。
        _ if output
            .stderr
            .to_lowercase()
            .contains("does not have any commits yet") =>
        {
            return Ok(LogOutcome { repo: true, commits: Vec::new(), has_more: false });
        }
        _ => {
            return Err(GitError::new("git_failed", first_line(&output.stderr).to_string()));
        }
    }
    let mut raw: Vec<LogEntry> = Vec::new();
    for line in output.stdout.lines() {
        if line.trim().is_empty() { continue; }
        let mut it = line.split('\u{1f}');
        let (Some(hash), Some(short_hash), Some(at), Some(an), Some(p), s) =
            (it.next(), it.next(), it.next(), it.next(), it.next(), it.next())
        else { continue };
        // subject 不含分隔符时 s 即全文；极端含 %x1f 则回收剩余。
        let subject = match it.next() {
            Some(extra) => format!("{s}\u{1f}{extra}"),
            None => s.to_string(),
        };
        let timestamp_ms = at.trim().parse::<u64>().unwrap_or(0) * 1000;
        raw.push(LogEntry {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            timestamp_ms,
            author_name: an.to_string(),
            is_merge: p.split_whitespace().count() > 1,
            subject,
        });
    }
    let has_more = raw.len() > limit;
    if has_more { raw.truncate(limit); }
    Ok(LogOutcome { repo: true, commits: raw, has_more })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: &'static str,
}

/// name-status -z：NUL 分隔字段流。普通 `M\0path\0`；重命名 `R100\0old\0new\0`。
/// 父：<hash>^（有）或 EMPTY_TREE（root）。用 two-diff 天然取首父，merge 归第一父。
pub fn commit_files(root: &Path, hash: &str) -> Result<Vec<ChangedFile>, GitError> {
    let parent = format!("{hash}^");
    let has_parent = run_git(root, &["--no-pager", "rev-parse", "--verify", "--quiet", &parent])
        .map(|o| o.exit_code == Some(0))
        .unwrap_or(false);
    let left = if has_parent { parent.as_str() } else { EMPTY_TREE };
    let output = run_git(
        root,
        &["--no-pager", "diff", "--name-status", "-z", left, hash],
    )?;
    if output.exit_code != Some(0) {
        return Err(GitError::new("git_failed", first_line(&output.stderr).to_string()));
    }
    Ok(parse_name_status_z(&output.stdout))
}

fn parse_name_status_z(stdout: &str) -> Vec<ChangedFile> {
    // 分词：NUL 分隔；每条为 status（R/C 带 score，后跟两路径），其余一路径。
    let toks: Vec<&str> = stdout.split('\0').filter(|t| !t.is_empty()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let status_tok = toks[i];
        let letter = status_tok.chars().next().unwrap_or('M');
        let two_path = matches!(letter, 'R' | 'C');
        if i + (if two_path { 3 } else { 2 }) > toks.len() { break; }
        let path = if two_path {
            let old = toks[i + 1].to_string();
            let new = toks[i + 2].to_string();
            i += 3;
            out.push(ChangedFile {
                path: new,
                old_path: Some(old),
                status: classify_name_status(letter),
            });
            continue;
        } else {
            let p = toks[i + 1].to_string();
            i += 2;
            p
        };
        out.push(ChangedFile { path, old_path: None, status: classify_name_status(letter) });
    }
    out
}

fn classify_name_status(letter: char) -> &'static str {
    match letter {
        'A' => "added",
        'D' => "deleted",
        'R' | 'C' => "renamed",
        _ => "modified", // M/T/U 一律归 modified（历史展示无需细分冲突/typechange）
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil;
    #[test]
    fn log_parses_subjects_authors_and_merge_flag() {
        let Some(root) = testutil::temp_repo_with_commit("logparse") else { return };
        // 追加第二个 commit + 一个 merge，断言顺序/计数/isMerge。
        // （具体 fixture：写文件→commit→--no-ff merge；见实现补全）
        let outcome = log(&root, 0, 10).unwrap();
        assert!(outcome.repo);
        assert!(!outcome.commits.is_empty());
        assert_eq!(outcome.commits[0].subject, "init");
        assert_eq!(outcome.commits[0].is_merge, false);
        std::fs::remove_dir_all(&root).ok();
    }
    #[test]
    fn commit_files_lists_changes_and_detects_rename() {
        let Some(root) = testutil::temp_repo_with_commit("cfiles") else { return };
        // 新增、修改、重命名各一，取最新 hash 断言 parse_name_status_z 与 oldPath。
        std::fs::remove_dir_all(&root).ok();
    }
    #[test]
    fn name_status_z_rename_maps_old_and_new_path() {
        let files = parse_name_status_z("R100\0old.txt\0new.txt\0M\0other.txt\0");
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[1].path, "other.txt");
        assert_eq!(files[1].status, "modified");
    }
}
```

- [ ] mod.rs 增 `mod log;` + `pub use log::{commit_files, log};`（LogOutcome 等经路径引用）。testutil 若缺 `temp_repo_with_commit` 已在 G2 添加，确认可用；两个 `#[ignore]` 型真仓测试补全 fixture（新增/改/重命名 + merge），必须真跑断言（不能空 return）。
- [ ] `cargo test --manifest-path crates/Cargo.toml`（补全 fixture 后）+ `cargo fmt`。

### Task H3: Rust commit_diff + branch 扩展

**Files:** Modify `git/diff.rs`、`git/service.rs`、`git/writes.rs`、`params.rs`、`git/mod.rs`

- [ ] diff.rs 增：

```rust
/// commit↔parent 单文件两侧内容（历史点开 diff 用）。两侧均 git 对象（恒 LF），
/// 不需工作树 EOL 归一；<hash>^ 不存在（root/新增）→ 空；删除→右侧空。
pub(super) fn commit_diff(
    workspace_root: &Path,
    hash: &str,
    relative: &str,
) -> Result<DiffOutcome, GitError> {
    resolve_in_workspace(workspace_root, relative)
        .map_err(|message| GitError::new("path_outside_workspace", message))?;
    let original = match read_git_blob(workspace_root, &format!("{hash}^:./{relative}"))? {
        BlobLookup::Content(c) => c,
        BlobLookup::Absent => BlobContent::default(),
        BlobLookup::NotARepo => return Ok(repo_false_diff()),
    };
    let modified = match read_git_blob(workspace_root, &format!("{hash}:./{relative}"))? {
        BlobLookup::Content(c) => c,
        BlobLookup::Absent => BlobContent::default(),
        BlobLookup::NotARepo => return Ok(repo_false_diff()),
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
```

service.rs：`pub fn commit_diff(root, hash, relative)` 薄委托（或 mod.rs 直接 `pub use diff::commit_diff` — 与 diff 一致走 service）。

- [ ] writes.rs：`checkout` 与 `branch_create` 放宽——新增 `validate_rev_or_branch`（hex 直通过；否则 validate_branch_name；再加含 `/` 的 remote-branch 形态允许）：

```rust
/// 检出/起点接受：本地分支名、十六进制 commit、`remote/branch`（形态安全，
/// 不校验 ref 是否存在，交给 git 报错）。
fn validate_revref(s: &str) -> Result<(), GitError> {
    let hex = s.len() >= 4 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit());
    if hex { return Ok(()); }
    validate_branch_name(s)
}
pub fn checkout(root: &Path, name: &str) -> Result<Value, GitError> {
    validate_revref(name)?;
    run_write(root, &["checkout", name], GIT_LOCAL_WRITE)
}
pub fn branch_create(root: &Path, name: &str, checkout_it: bool, start: Option<&str>) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    let mut args: Vec<&str> = Vec::new();
    if checkout_it { args.extend(["checkout", "-b", name]); } else { args.extend(["branch", name]); }
    if let Some(s) = start { validate_revref(s)?; args.push(s); }
    run_write(root, &args, GIT_LOCAL_WRITE)
}
```

（`validate_branch_name` 现允许 `/`；确认其 charset 白名单含 `/`——G3 已含。`remote/x` 通过。）

- [ ] params.rs：`GitCheckoutParams`/`GitBranchCreateParams` 的 `name` 复用；`GitBranchCreateParams` 增 `start_ref: Option<String>`（camelCase `startRef`）；新增 `GitLogParams{workspace_root, skip:Option<usize>, limit:Option<usize>}`、`GitCommitFilesParams{workspace_root, hash}`、`GitCommitDiffParams{workspace_root, hash, path}`（均 deny_unknown_fields）。
- [ ] handlers.rs：commit_diff/branch_create 调用改带 startRef（`branch_create(root,&name,checkout,start.as_deref())`）。log/commit_files 的 handler 在 H4 建。
- [ ] main.rs：`git.commit_diff` 路由（若拆 handler 见 H4）。
- [ ] `cargo test` + fmt。

### Task H4: 拆 handlers_git.rs + log/commit_files/commit_diff handler + 路由

**Files:** Create `crates/system-runtime/src/handlers_git.rs`；Modify `handlers.rs`、`main.rs`

- [ ] 把 handlers.rs 内全部 `handle_git_*`（status/diff/branches + 8 写 + 新 log/commit_files/commit_diff）整体迁到 `handlers_git.rs`（`pub fn` 保持签名），handlers.rs 顶部 `mod`/`use` 相应调整；main.rs 的 git 路由改 `handlers_git::…`（其余不变）。纯移动不改逻辑（AGENTS 格式化与重构分离——本步只移动 + 加新 handler）。新增 3 个只读 handler（异步模板，读操作用 GIT_RO，主线程解析）：`handle_git_log`、`handle_git_commit_files`、`handle_git_commit_diff`。

- [ ] main.rs 路由：

```rust
        Some("git.log") => handlers_git::handle_git_log(id, params),
        Some("git.commit_files") => handlers_git::handle_git_commit_files(id, params),
        Some("git.commit_diff") => handlers_git::handle_git_commit_diff(id, params),
```

- [ ] log.rs/各 handler 补单测；`cargo test`/`cargo fmt`/`cargo build` 全绿。

### Task H5: runtime workspace 命令（历史）

**Files:** Modify `apps/runtime/src/workspace/handlers.ts`

- [ ] 新增：

```ts
  'workspace.git_log': async (p, { store, system }) => {
    const project = requireWorkspaceProject(store, requireString(p, 'projectId'))
    const params: Record<string, unknown> = { workspaceRoot: project.folderPath }
    if (typeof p.skip === 'number') params.skip = Math.max(0, Math.trunc(p.skip))
    if (typeof p.limit === 'number') params.limit = Math.max(1, Math.trunc(p.limit))
    const r = (await requestSystem(system, 'git.log', params)) as {
      repo: boolean; commits: unknown[]; hasMore: boolean
    }
    return { repo: r.repo, commits: r.commits ?? [], hasMore: r.hasMore ?? false }
  },
  'workspace.git_commit_files': async (p, { store, system }) => {
    const project = requireWorkspaceProject(store, requireString(p, 'projectId'))
    const hash = requireHash(p)
    const r = (await requestSystem(system, 'git.commit_files', {
      workspaceRoot: project.folderPath, hash,
    })) as { files?: unknown[] }
    return { files: r.files ?? [] }
  },
  'workspace.git_commit_diff': async (p, { store, system }) => {
    const project = requireWorkspaceProject(store, requireString(p, 'projectId'))
    const hash = requireHash(p)
    const path = assertRelativePath(requireString(p, 'path'))
    return (await requestSystem(system, 'git.commit_diff', {
      workspaceRoot: project.folderPath, hash, path,
    })) as Record<string, unknown>
  },
```

`git_branch_create` handler 增透传 `startRef`（string 可选）。私有助手 `requireHash`（正则 `/^[0-9a-fA-F]{4,64}$/` 否则 invalid_request）。

- [ ] `apps/runtime/test/handlers.test.mjs`：git_log 分页透传、git_commit_diff 非法 hash 拒绝、branch_create startRef 透传。command-coverage 动态枚举应自动纳入。
- [ ] `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime test`。

### Task H6: 前端历史面板

**Files:** Create `GitHistory.tsx`、`git-time.ts`；Modify `ProjectFiles.tsx`、`api/workspace.ts`、`workspace.css`

- [ ] api/workspace.ts 增 `gitLog(projectId, {skip?, limit?})`、`gitCommitFiles(projectId, hash)`、`gitCommitDiff(projectId, hash, path)`（返回 `{original, modified, binary, truncated}`）；`gitBranchCreate` 增 `startRef?`。
- [ ] git-time.ts：`formatRelativeTime(timestampMs, nowMs)`：`<60m`→「n 分钟前」，`<24h`→「n 小时前」，`<7d`→「n 天前」，否则 `YYYY-MM-DD`。纯函数。
- [ ] GitHistory.tsx（≤300 行）：props `{projectId, systemReady, onOpenDiff, guardDirtyBuffersThen, reloadAllTextTabs, onAfterMutation}`。状态 `commits/hasMore/loading/error/expandedHash/filesCache(Map)`。加载 `gitLog`；行展开→`gitCommitFiles(hash)`（缓存）；文件点击→`gitCommitDiff` 取全文→`onOpenDiff(path, {source:'chat', before:original, after:modified})`；行尾「⋯」菜单：复制哈希 / 基于此建分支 / 检出此提交。检出/建分支 checkout→先 `await guardDirtyBuffersThen()`，成功 `reloadAllTextTabs()` + `onAfterMutation()` + 重载 log。底部「加载更多」skip+=50。合并提交文件区显示「（对第一父）」提示。非仓库/空仓库/loading/error 态复用 git-hint。
- [ ] ProjectFiles：View 联合加 `'history'`，tab 条加「历史」按钮（复用 project-files-tab），渲染 `<GitHistory …/>` 并把 GitChanges 已有的 guard/reload/onAfterMutation props 一并传入。
- [ ] workspace.css：`.git-hist-row`/`.git-hist-meta`/`.git-hist-files`/`.git-hist-subject`/菜单复用 `.git-branch-menu`；相对时间 muted 小字。
- [ ] typecheck + lint + prettier。

### Task H7: e2e（历史）+ 子批 H 门禁

- [ ] `apps/runtime/test/system-e2e-git.test.mjs` 扩展（或新建 `system-e2e-history.test.mjs` 并登记进 package.json 清单）：commit 后 `git_log` 含该 subject；`git_commit_files` 列出改动；`git_commit_diff` 两侧内容正确；rename 场景 oldPath；基于最新 commit 建分支并切换成功。真实二进制、0 skip。
- [ ] 子批 H 门禁：format/lint/typecheck/desktop/build:packages/cargo test+fmt/runtime(带二进制)。

---

## 子批 R：远程管理

### Task R1: contracts

- [ ] 新增：

```ts
  'workspace.git_remotes': {
    params: z.object({ requestId: RequestIdSchema, projectId: z.string().min(1) }),
    result: z.object({
      repo: z.boolean(),
      remotes: z.array(z.object({ name: z.string(), url: z.string() })),
    }),
  },
  'workspace.git_remote_add': {
    params: z.object({
      requestId: RequestIdSchema, projectId: z.string().min(1),
      name: z.string().min(1), url: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_remote_remove': {
    params: z.object({
      requestId: RequestIdSchema, projectId: z.string().min(1), name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
```

`workspace.git_branches` result 增 `remoteBranches: z.array(z.string())`。

### Task R2: Rust remotes + branches 扩展

- [ ] Create `git/remotes.rs`：`list(root)`→`git remote -v`，解析 fetch 行，**剥 userinfo**（正则 `^(\w+://)([^@/]+)@` → 前缀 + `***@`）；`add(root,name,url)`：validate_branch_name(name) + `validate_url`（`https://`/`ssh://`/`git@host:path`/`file://` 白名单前缀 + 无控制/空白/前导-）→ `git remote add name url`；`remove(root,name)`→`git remote remove`。全部 GIT_LOCAL_WRITE（add/remove 可能不触网）。
- [ ] service.rs `branches()`：追加 `for-each-ref --format=%(refname:short) refs/remotes` 解析，剔除以 `/HEAD` 结尾项，返回 `remoteBranches: Vec<String>`；`BranchesOutcome` 增字段 + `#[serde]`。
- [ ] mod.rs 暴露 `remotes::{list as remotes_list, add as remote_add, remove as remote_remove}`（或 service 薄委托）。params.rs：`GitRootParams` 复用于 remotes 列表；新增 `GitRemoteAddParams{workspace_root,name,url}`、`GitRemoteRemoveParams{workspace_root,name}`（deny_unknown_fields）。
- [ ] handlers_git.rs：`handle_git_remotes`（读，GIT_RO）、`handle_git_remote_add`、`handle_git_remote_remove`（写）。main.rs 路由 3 条。
- [ ] 单测：真仓 `remote add origin file:///…` 往返；URL 含 `user:token@` 断言 list 剥凭据；非法 URL（`ext::sh -c`、前导 `-`、含空格）拒绝；branches 含 remoteBranches。

### Task R3: runtime 命令（远程）

- [ ] handlers.ts：`git_remotes`/`git_remote_add`/`git_remote_remove`（后两 withGitQueue），`git_branches` 透传补 `remoteBranches`。
- [ ] handlers.test.mjs：remote_add 队列 + 参数、branches remoteBranches 透传、非法 URL runtime 侧不拦截（交 Rust）但 name 空拒绝。

### Task R4: 前端 BranchPicker 扩展

- [ ] api/workspace.ts：`gitRemotes/gitRemoteAdd/gitRemoteRemove`；`gitBranches` 返回类型增 `remoteBranches`。
- [ ] BranchPicker.tsx：菜单三分区——本地（现状）/ 远程分支（`origin/x` 点击→建本地分支预填名+startRef=`origin/x`，走现有 onSwitch/onCreate）/ 远端（`gitRemotes` 列表 name+masked URL + 移除按钮[ConfirmDialog] + 「添加远端」name/url 表单）。新增 props `remotes` 拉取与变更后刷新回调。≤260 行，超出则拆 `GitRemotesSection.tsx`。
- [ ] workspace.css：`.git-remote-row`、`.git-remote-add-form`、`.git-branch-section` 分区标题。

### Task R5: e2e（远程）+ 全批门禁 + 文档

- [ ] `system-e2e-git.test.mjs`（或新文件登记）：`git_remotes` 空→`git_remote_add`(file:// bare)→list 可见→branches.remoteBranches（fetch 后含 origin/main）→基于远程分支建本地跟踪分支成功、status.branch 更新→`git_remote_remove`→list 空。
- [ ] 全量门禁（AGENTS §6 全序列 + runtime 带二进制 + desktop typecheck）。
- [ ] 文档：AGENTS.md Phase 状态补「Git 历史浏览/导航 + 远程管理」；ROADMAP 1B 待完成移除历史/远程项，保留 force-push/discard/stash；spec 影响面核对。

---

## 自查备注

- 覆盖 spec 全项：log(a)+commit_files+commit_diff+checkout/branch 导航(b)+branch_switch hex+startRef；remotes list/add/remove(R-a)+remoteBranches+发布复用。破坏性动作零引入（无 revert/reset/del-remote）。
- `handlers_git.rs` 拆分（H4）兑现 spec「触碰 handlers.rs 当次拆」。
- 风险点集中 H2 的 log/name-status 解析与 R2 URL 剥凭据——均有真仓/真二进制测试兜底。
