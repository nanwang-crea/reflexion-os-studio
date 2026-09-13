# Git 写操作（方案 A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作区 Git 面板添加 stage/unstage/commit/fetch/push/pull(--ff-only)/branch 创建与切换，含脏 buffer 守卫与操作后刷新联动。

**Architecture:** Rust `git/` 模块扩枚举子命令（argv 固定拼装、`run_git_opts` 带操作级超时与防交互 env）；Runtime 按 workspaceRoot 串行队列转发；Tauri 白名单登记；前端 GitChanges 重构为 VS Code SCM 布局，checkout/pull 前复用三键守卫、成功后 bump nonce 强制重载文本标签。

**Tech Stack:** Rust（serde/serde_json）、TypeScript strict、React 19、zod 契约、node:test。

**Spec:** `docs/superpowers/specs/2026-09-12-git-write-ops-design.md`

**约定：** 不 commit；前端无测试设施（typecheck+lint 验证）；runtime 测试在 `apps/runtime/test/*.mjs`（跑 dist，改 TS 先 `pnpm build:packages`）；真实二进制测试需 `REFLEXION_SYSTEM_RUNTIME_BIN=$PWD/../../crates/target/debug/reflexion-system-runtime`；格式化仅针对本次文件：`npx prettier --write <files>`。Rust 用 `cargo fmt --manifest-path crates/Cargo.toml`。

---

### Task 1: contracts 命令契约

**Files:**

- Modify: `packages/contracts/src/commands.ts`

- [ ] **Step 1: 在 `workspace.git_branches` 条目后新增 8 个命令 schema + 扩展 git_status result**

```ts
  // ---------- Git 写操作（方案 A：UI 直接动作，免审批凭据；Rust 枚举拼装 argv） ----------
  'workspace.git_stage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_unstage': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_commit': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      message: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_fetch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_push': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_pull': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_create': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
      checkout: z.boolean().optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.git_branch_switch': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
      name: z.string().min(1),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
```

现有 `workspace.git_status` 的 result（`repo/entries/truncated` 对象）增加四字段：

```ts
      branch: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative().nullable(),
      behind: z.number().int().nonnegative().nullable(),
```

- [ ] **Step 2:** `pnpm build:packages` 通过（zod→类型派生自动生效）。

---

### Task 2: Rust exec 层：操作级超时 + 防交互 env

**Files:**

- Modify: `crates/system-runtime/src/git/exec.rs`

- [ ] **Step 1: 抽出 `run_git_opts`，`run_git` 变薄委托**

在 `run_git` 前新增选项结构并重构签名（保持 `pub(super)` 可见性与既有调用不变）：

```rust
/// git 运行选项：默认档（只读，15s）与写/网络档（120s + 禁交互提示）。
#[derive(Clone, Copy)]
pub(super) struct GitRunOpts {
    pub timeout_ms: u64,
    /// 网络命令禁止 git 挂起等待终端/askpass 输入（凭据缺失快速失败，stderr 引导）。
    pub noninteractive: bool,
}

pub(super) const GIT_RO: GitRunOpts = GitRunOpts { timeout_ms: DEFAULT_TIMEOUT_MS, noninteractive: false };
pub(super) const GIT_LOCAL_WRITE: GitRunOpts = GitRunOpts { timeout_ms: 30_000, noninteractive: false };
pub(super) const GIT_NETWORK: GitRunOpts = GitRunOpts { timeout_ms: 120_000, noninteractive: true };

pub(super) fn run_git(workspace_root: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    run_git_opts(workspace_root, args, GIT_RO)
}

pub(super) fn run_git_opts(
    workspace_root: &Path,
    args: &[&str],
    opts: GitRunOpts,
) -> Result<GitOutput, GitError> {
    // 原 run_git 函数体整体移入；两处修改：
    // 1) `Duration::from_millis(DEFAULT_TIMEOUT_MS)` → `Duration::from_millis(opts.timeout_ms)`
    // 2) 命令构造处补 env：
    //    if opts.noninteractive {
    //        command.env("GIT_TERMINAL_PROMPT", "0").env("GIT_ASKPASS", "");
    //    }
}
```

（迁移函数体时不改其他逻辑；`GitError` 分支原样保留。）

- [ ] **Step 2:** `cargo check --manifest-path crates/Cargo.toml && cargo test --manifest-path crates/Cargo.toml` 全绿（既有调用零改动）。

---

### Task 3: Rust status v2：branch/upstream/ahead/behind

**Files:**

- Modify: `crates/system-runtime/src/git/status.rs`

- [ ] **Step 1: StatusOutcome 增加字段**

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutcome {
    pub repo: bool,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
}
```

- [ ] **Step 2: 命令换 v2 并解析头块**

`status()` 中 argv 改为：

```rust
    let output = run_git(
        workspace_root,
        &[
            "--no-pager",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
```

非仓库分支返回 `repo:false` + 四新字段 None；成功分支 `parse_status` 换签名 `fn parse_status(stdout: &str) -> StatusOutcome`，实现：

```rust
/// v2 -z：头记录 `# branch.head <name>` / `# branch.upstream <u>` /
/// `# branch.ab +N -M`（ahead=+N, behind=-M）；条目 `1|2 …path`、`2` 的
/// origPath 为下一条记录、`? …path`、`u …path`（冲突按 v1 同类逻辑处理为 conflicted）。
fn parse_status(stdout: &str) -> StatusOutcome {
    let mut entries: Vec<StatusEntry> = Vec::new();
    let mut branch: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut ahead: Option<u64> = None;
    let mut behind: Option<u64> = None;
    let mut truncated = false;
    let mut records = stdout.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            branch = if rest == "(detached)" { None } else { Some(rest.to_string()) };
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.ab ") {
            let mut parts = rest.split(' ');
            ahead = parts.next().and_then(|v| v.strip_prefix('+')).and_then(|v| v.parse().ok());
            behind = parts.next().and_then(|v| v.strip_prefix('-')).and_then(|v| v.parse().ok());
            continue;
        }
        if record.starts_with("# ") || record.starts_with("! ") {
            continue; // 其它头/ignored：忽略
        }
        let xy = (record.as_bytes().get(2), record.as_bytes().get(3));
        let (x, y) = match xy {
            (Some(a), Some(b)) => (*a, *b),
            _ => { truncated = true; break }
        };
        if record.starts_with("? ") {
            let (status, staged) = classify_xy(b'?', b'?');
            entries.push(StatusEntry { path: record[2..].to_string(), old_path: None, status, staged });
            continue;
        }
        let kind = record.as_bytes()[0];
        // 1/2/u 条目：path 在第 9/9/11 个空格后（v2 定长字段数）。
        let fields_before = match kind { b'1' | b'2' => 9, b'u' => 11, _ => { truncated = true; break } };
        let path = match record.splitn(fields_before + 1, ' ').nth(fields_before) {
            Some(path) => path.to_string(),
            None => { truncated = true; break },
        };
        let old_path = if kind == b'2' {
            match records.next() {
                Some(old) if !old.is_empty() => Some(old.to_string()),
                _ => { truncated = true; None }
            }
        } else { None };
        let (status, staged) = classify_xy(x, y);
        entries.push(StatusEntry { path, old_path, status, staged });
    }
    StatusOutcome { repo: true, entries, truncated, branch, upstream, ahead, behind }
}
```

- [ ] **Step 3: 提取共享测试助手 + 更新/新增测试**

`git/mod.rs` 增加（service.rs 的 tests 模块删除本地三助手改用它们，行为不变）：

```rust
#[cfg(test)]
pub(crate) mod testutil {
    // 从 service.rs tests 原样迁移 temp_workspace/git_cli/temp_repo/write，
    // 另加：temp_repo_with_commit(tag) —— init + 写 seed.txt + add . + commit
    // "init"（返回 repo 路径；git 缺失返回 None 由用例跳过）；
    // default_branch(root) —— `git symbolic-ref --short HEAD` 输出（分支名跨
    // 机器断言用，init 默认分支受用户配置影响）。全部 pub(crate)。
}
```

status.rs tests：`parses_porcelain_v1_z_records` 重写为 v2 样例——输入
`"# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0""1 M. N... 100644 100644 100644 aabbccd aabbccd f.txt\0""2 R. N... 100644 100644 100644 aabbccd aabbccd new.txt\0""old.txt\0""? n.txt\0"`，
断言 `branch=Some("main")`、`upstream=Some("origin/main")`、`ahead=Some(2)`、`behind=Some(1)`、entries 依次 modified(staged=true)/renamed(old=old.txt)/untracked；再加一条 detached 头（`# branch.head (detached)`）断言 branch=None。

真仓集成测试（status.rs tests 内，用 `super::super::testutil`）：

```rust
    #[test]
    fn status_reports_branch_and_none_upstream_against_real_repo() {
        let Some(root) = testutil::temp_repo_with_commit("v2status") else { return };
        let expected = testutil::default_branch(&root);
        let outcome = status(&root).unwrap();
        assert_eq!(outcome.repo, true);
        assert_eq!(outcome.branch.as_deref(), Some(expected.as_str()));
        assert_eq!(outcome.upstream, None);
        assert_eq!(outcome.ahead, None);
        assert_eq!(outcome.behind, None);
        std::fs::remove_dir_all(&root).ok();
    }
```

- [ ] **Step 4:** `cargo test --manifest-path crates/Cargo.toml` 全绿；`cargo fmt`。

---

### Task 4: Rust 写命令（git/writes.rs + 分发）

**Files:**

- Create: `crates/system-runtime/src/git/writes.rs`
- Modify: `crates/system-runtime/src/git/mod.rs`、`git/service.rs`（re-export）、`params.rs`、`handlers.rs`、`main.rs`

- [ ] **Step 1: writes.rs——校验器 + 8 操作**

```rust
//! Git 写类子命令：argv 全部按命令枚举固定拼装，路径/分支名服务端校验；
//! UI 命令由 Runtime 声明来源（本层免 grant——grant 属 agent 工具链边界）。

use std::path::Path;

use serde_json::{json, Value};

use super::exec::{first_line, run_git_opts, GitRunOpts, GIT_LOCAL_WRITE, GIT_NETWORK, GIT_RO};
use super::service::GitError;

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
fn run_write(
    root: &Path,
    args: &[&str],
    opts: GitRunOpts,
    not_repo_ok: bool,
) -> Result<Value, GitError> {
    let output = run_git_opts(root, args, opts)?;
    if output.timed_out {
        return Err(GitError::new("git_failed", format!("git {} timed out", args.get(1).copied().unwrap_or(""))));
    }
    if output.exit_code == Some(0) {
        return Ok(json!({ "ok": true }));
    }
    if not_repo_ok && super::status::is_not_a_repo(&output) {
        return Err(GitError::new("git_failed", "not a git repository".to_string()));
    }
    let mut message = first_line(&output.stderr).to_string();
    if message.is_empty() {
        message = first_line(&output.stdout).to_string();
    }
    Err(GitError::new("git_failed", message))
}

pub fn stage(root: &Path, paths: &[String]) -> Result<Value, GitError> {
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in paths { args.push(validate_rel_path(p)?); }
    run_write(root, &args, GIT_LOCAL_WRITE, false)
}

pub fn unstage(root: &Path, paths: &[String]) -> Result<Value, GitError> {
    let mut args: Vec<&str> = vec!["reset", "--"];
    for p in paths { args.push(validate_rel_path(p)?); }
    run_write(root, &args, GIT_LOCAL_WRITE, false)
}

pub fn commit(root: &Path, message: &str) -> Result<Value, GitError> {
    if message.trim().is_empty() {
        return Err(GitError::new("invalid_request", "commit message is empty".to_string()));
    }
    run_write(root, &["commit", "-m", message], GIT_LOCAL_WRITE, false)
}

pub fn fetch(root: &Path) -> Result<Value, GitError> {
    run_write(root, &["fetch", "origin"], GIT_NETWORK, false)
}

pub fn pull(root: &Path) -> Result<Value, GitError> {
    run_write(root, &["pull", "--ff-only"], GIT_NETWORK, false)
}

fn current_branch(root: &Path) -> Result<Option<String>, GitError> {
    let output = run_git_opts(root, &["--no-pager", "branch", "--show-current"], GIT_RO)?;
    if output.exit_code != Some(0) {
        return Err(GitError::new("git_failed", first_line(&output.stderr).to_string()));
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
        return run_write(root, &["push"], GIT_NETWORK, false);
    }
    let branch = current_branch(root)?.ok_or_else(|| {
        GitError::new("git_failed", "HEAD is detached; create a branch before pushing".to_string())
    })?;
    validate_branch_name(&branch)?;
    run_write(root, &["push", "-u", "origin", branch.as_str()], GIT_NETWORK, false)
}

pub fn branch_create(root: &Path, name: &str, checkout: bool) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    if checkout {
        run_write(root, &["checkout", "-b", name], GIT_LOCAL_WRITE, false)
    } else {
        run_write(root, &["branch", name], GIT_LOCAL_WRITE, false)
    }
}

pub fn checkout(root: &Path, name: &str) -> Result<Value, GitError> {
    validate_branch_name(name)?;
    run_write(root, &["checkout", name], GIT_LOCAL_WRITE, false)
}
```

- [ ] **Step 2: mod.rs** 增加 `mod writes;`；`pub use service::{branches, diff, status};` 下加一行：

```rust
pub use writes::{branch_create, checkout, commit, fetch, pull, push, stage, unstage};
```

（`git/service.rs` 顶部注释补一句"写子命令见 writes.rs"。）

- [ ] **Step 3: params.rs** 追加（模式与 GitDiffParams 一致）：

```rust
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutParams {
    pub workspace_root: String,
    pub name: String,
}
```

（`GitRootParams` 复用于 fetch/pull/push。）

- [ ] **Step 4: handlers.rs** 追加 8 个同构 handler（模板即 `handle_git_status` 的形态：解自身 Params → `workspace_root` → clone 所需参数 → `std::thread::spawn` 内 `match git::<op>(…)` emit ok/err → 返回 `(Null, false)`）。完整给出两条代表，其余 6 条按对照表套用（fetch/pull/push 仅 root；branch_switch→`git::checkout`；branch_create 传 `checkout.unwrap_or(false)`；unstage 同 stage 换函数）：

```rust
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
```

- [ ] **Step 5: main.rs** 路由表在 `git.branches` 行后追加：

```rust
        Some("git.stage") => handlers::handle_git_stage(id, params),
        Some("git.unstage") => handlers::handle_git_unstage(id, params),
        Some("git.commit") => handlers::handle_git_commit(id, params),
        Some("git.fetch") => handlers::handle_git_fetch(id, params),
        Some("git.push") => handlers::handle_git_push(id, params),
        Some("git.pull") => handlers::handle_git_pull(id, params),
        Some("git.branch_create") => handlers::handle_git_branch_create(id, params),
        Some("git.branch_switch") => handlers::handle_git_branch_switch(id, params),
```

- [ ] **Step 6: writes.rs 单测**（temp repo 模式与 service.rs 相同，用 Step 4 of Task3 的 `testutil`）：

```rust
#[cfg(test)]
mod tests {
    // testutil::{temp_repo_with_commit, write_file_in}（Task 3 建）
    #[test] fn stage_then_status_shows_staged_and_commit_succeeds()
    // write f.txt → stage(["f.txt"]) → git::status 断言 entries[0].staged==true
    // → commit("msg") → status 干净
    #[test] fn rejects_unsafe_paths_and_branch_names()
    // stage(["../x"]) → path_outside_workspace；branch_create("a b")、("-x")、("..") → invalid_request
    #[test] fn checkout_switches_back_and_forth()
    // branch_create("feature", true) → status.branch==Some("feature") → checkout 回主分支
}
```

- [ ] **Step 7:** `cargo test --manifest-path crates/Cargo.toml` + `cargo fmt` 全绿。

---

### Task 5: Runtime workspace 命令 + 串行队列

**Files:**

- Create: `apps/runtime/src/workspace/git-queue.ts`
- Modify: `apps/runtime/src/workspace/handlers.ts`、`apps/runtime/test/command-coverage.test.mjs`

- [ ] **Step 1: git-queue.ts**

```ts
/** 按 workspaceRoot 串行化 git 变更命令：index.lock 互斥是硬约束。 */
const chains = new Map<string, Promise<unknown>>()

export function withGitQueue<T>(
  root: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(root) ?? Promise.resolve()
  const next = prev.then(task, task)
  chains.set(
    root,
    next.catch(() => {}),
  )
  return next
}
```

- [ ] **Step 2: handlers.ts 新增 8 命令**（模板：requireWorkspaceProject → 参数校验 → withGitQueue + requestSystem 带超时）。`requestSystem` 现签名追加 `timeoutMs?: number`（默认 30_000 不变）：

```ts
async function requestSystem(
  system: SystemRuntimeClient,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> { …原体内 { timeoutMs }… }
```

命令体示例（其余 7 条同构，方法/参数按表）：

```ts
  'workspace.git_stage': (p, { store, system }) => {
    const project = requireWorkspaceProject(store, requireString(p, 'projectId'))
    const paths = requireStringArray(p, 'paths')
    return withGitQueue(project.folderPath, () =>
      requestSystem(system, 'git.stage', {
        workspaceRoot: project.folderPath,
        paths: paths.map(assertRelativePath),
      }),
    )
  },
```

`requireStringArray` 加到 handlers.ts 私有助手（空数组/非字符串 → invalid_request）。对照表：

| 命令              | Rust 方法         | params                                      | 超时    |
| ----------------- | ----------------- | ------------------------------------------- | ------- |
| git_stage         | git.stage         | paths→`paths.map(assertRelativePath)`       | 默认    |
| git_unstage       | git.unstage       | 同上                                        | 默认    |
| git_commit        | git.commit        | message=requireString 非空                  | 默认    |
| git_fetch         | git.fetch         | —                                           | 120_000 |
| git_push          | git.push          | —                                           | 120_000 |
| git_pull          | git.pull          | —                                           | 120_000 |
| git_branch_create | git.branch_create | name=requireString, checkout=typeof boolean | 默认    |
| git_branch_switch | git.branch_switch | name                                        | 默认    |

全部返回 `{ ok: true as const }`（Rust 已回 `{"ok":true}`，透传 `as { ok: boolean }`）。`workspace.git_status` handler 透传补四字段：`branch: result.branch ?? null, upstream: result.upstream ?? null, ahead: result.ahead ?? null, behind: result.behind ?? null`。

- [ ] **Step 3: 测试**——`handlers.test.mjs` 新增 3 条：stage 参数透传+queue 串行（同一 root 两命令 fake system 记录调用不交叠：第一个 request 挂起、第二个必须排队，release 后顺序断言）；commit 空 message → invalid_request；git_status 新字段透传。`command-coverage.test.mjs`：把新命令加入其期望清单（先读该测试的枚举方式再改）。

- [ ] **Step 4:** `pnpm build:packages && pnpm --filter @reflexion-os-studio/runtime test` 全绿。

---

### Task 6: Tauri 白名单

**Files:**

- Modify: `apps/desktop/src-tauri/src/lib.rs`（或 `grep -rn "RUNTIME_METHODS =" apps/desktop/src-tauri/src` 找到定义处）

- [ ] **Step 1:** `RUNTIME_METHODS` 数组追加 8 个方法名（`workspace.git_stage` … `workspace.git_branch_switch`）。
- [ ] **Step 2:** `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`。

---

### Task 7: 前端 api + 状态层

**Files:**

- Modify: `apps/desktop/frontend/api/workspace.ts`、`hooks/useWorkspacePanel.ts`、`features/workspace/FileViewerPanel.tsx`、`hooks/useWorkspaceTabGuard.ts`

- [ ] **Step 1: api/workspace.ts**

`gitStatus` 返回类型加 `branch: string | null; upstream: string | null; ahead: number | null; behind: number | null`；新增：

```ts
type GitOk = { ok: true }

function gitWrite(
  method: string,
  projectId: string,
  extra: Record<string, unknown> = {},
): Promise<GitOk> {
  return request<GitOk>(method, { projectId, ...extra })
}

export const gitStage = (projectId: string, paths: string[]) =>
  gitWrite('workspace.git_stage', projectId, { paths })
export const gitUnstage = (projectId: string, paths: string[]) =>
  gitWrite('workspace.git_unstage', projectId, { paths })
export const gitCommit = (projectId: string, message: string) =>
  gitWrite('workspace.git_commit', projectId, { message })
export const gitFetch = (projectId: string) =>
  gitWrite('workspace.git_fetch', projectId)
export const gitPush = (projectId: string) =>
  gitWrite('workspace.git_push', projectId)
export const gitPull = (projectId: string) =>
  gitWrite('workspace.git_pull', projectId)
export const gitBranchCreate = (
  projectId: string,
  name: string,
  checkout: boolean,
) => gitWrite('workspace.git_branch_create', projectId, { name, checkout })
export const gitBranchSwitch = (projectId: string, name: string) =>
  gitWrite('workspace.git_branch_switch', projectId, { name })
```

- [ ] **Step 2: useWorkspacePanel 增加 reloadAllTextTabs**

```ts
/** git checkout/pull 后强制所有文本标签从磁盘重载（bump nonce）。 */
const reloadAllTextTabs = useCallback((): void => {
  const stamp = Date.now()
  setOpenTabs((tabs) =>
    tabs.map((tab) => (tab.mode === 'diff' ? tab : { ...tab, nonce: stamp })),
  )
}, [])
```

接口与 return 补 `reloadAllTextTabs: () => void`。

- [ ] **Step 3: FileViewerPanel 保活 key 带 nonce**

```tsx
          <div
            key={`${tab.path}#${tab.nonce ?? 0}`}
```

- [ ] **Step 4: useWorkspaceTabGuard 提取 guardDirtyBuffersThen**

把 `guardedResetWorkspaceFiles` 的"检查→三键→保存全部→成功/放弃"段提取为：

```ts
/** 缓冲守卫：dirtyPaths 非空时三键（保存全部/放弃/取消），返回是否可继续。 */
const guardDirtyBuffersThen = useCallback(async (): Promise<boolean> => {
  const { dirtyPaths, confirmAction, setNotice, filePanelRef } = latest.current
  if (dirtyPaths.size === 0) return true
  const result = await confirmAction({
    title: '有未保存的修改',
    message: `接下来将改变工作区文件，${dirtyPaths.size} 个未保存文件需先处理。`,
    confirmLabel: '保存全部并继续',
    tertiaryLabel: '放弃修改并继续',
  })
  if (result === 'cancel') return false
  if (result === 'confirm') {
    const { failed } = (await filePanelRef.current?.saveAllDirty()) ?? {
      saved: [],
      failed: ['（文件句柄不可用）'],
    }
    if (failed.length > 0) {
      setNotice(`保存失败：${failed.join('、')}，已中止操作。`)
      return false
    }
  }
  return true
}, [])
```

`guardedResetWorkspaceFiles` 改为复用它 + `resetWorkspaceFiles()`（保持原行为与文案语义：把"切换项目"专用 message 参数化——`guardDirtyBuffersThen(message?: string)`，默认文案如上，guardedReset 传原文案）。接口加 `guardDirtyBuffersThen`。

- [ ] **Step 5:** `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`（App 未接线前允许 GitChanges 未消费新导出）。

---

### Task 8: GitChanges SCM 面板重构 + BranchPicker

**Files:**

- Create: `apps/desktop/frontend/features/workspace/BranchPicker.tsx`
- Rewrite: `apps/desktop/frontend/features/workspace/GitChanges.tsx`
- Modify: `apps/desktop/frontend/features/workspace/workspace.css`

- [ ] **Step 1: BranchPicker.tsx（分支芯片+下拉+新建）**

Props：`{ branch: string|null; ahead: number|null; behind: number|null; branches: string[]; busy: boolean; onSwitch(name): void; onCreate(name, checkout): void; onRefresh(): void }`。芯片按钮显示 `⑂ {branch ?? '—'} {behind ? \`↓${behind}\` : ''}{ahead ? \` ↑${ahead}\` : ''}`；点击展开下拉（absolute，复用 `dialog` 系视觉），列出分支（当前项打 ✓ 禁用），底部新建输入 + "创建并切换" checkbox + 创建按钮；`onSwitch`/`onCreate` 由父层做守卫与错误处理。空分支名输入禁用。文件 ≤160 行。

- [ ] **Step 2: GitChanges.tsx 重写**

状态机：`repo/entries/truncated/branch/upstream/ahead/behind/loading/error/busy: string | null（'commit'|'push'|'pull'|'stage'|…）`；`message: string`。结构：

```tsx
<div className="git-changes">
  <BranchPicker … />                       {/* 状态来自 gitStatus + gitBranches 合并 */}
  <div className="git-commit-box">
    <textarea
      className="git-commit-input"
      placeholder="提交信息（⌘/Ctrl+Enter 提交）"
      value={message}
      onChange={…}
      onKeyDown={(e) => { if ((IS_MAC ? e.metaKey : e.ctrlKey) && e.key === 'Enter') void run('commit', false) }}
    />
    <div className="git-commit-actions">
      <button disabled={!canCommit || busy !== null} onClick={() => void run('commit', false)}>提交</button>
      <button disabled={!canCommit || busy !== null} onClick={() => void run('commit', true)}>提交并推送</button>
    </div>
  </div>
  <div className="file-tree-bar">
    <span>变更 {…count} / 暂存区分组标题</span>
    <button 全部暂存 onClick={() => void runPaths('stage', unstagedPaths)} />
    <button 全部取消 … onClick={() => void runPaths('unstage', stagedPaths)} />
    <button 刷新 → refreshWithFetch() />
  </div>
  <ul className="git-list">
    {/* 两组：已暂存（右端 − 按钮 unstage）、未暂存（右端 + 按钮 stage；conflicted 隐藏两按钮）；
        行主体保持现有 onOpenDiff 点击。 */}
  </ul>
  {error && <div className="git-hint git-hint-error">{error}</div>}
</div>
```

动作编排（`run(kind)`）：busy 设置→清 error→ 需守卫的（'checkout'/'pull'）先 `await props.guardDirtyBuffersThen()`，false 即中止；成功后 `props.reloadAllTextTabs()`（仅 checkout/pull）→ `refresh()` → 后台 `void gitFetch(projectId).then(refresh-silent)`；失败 `setError(分类文案+原始 stderr 首行)`。push 无 staged 且无 commit 时可直接推送已有 ahead。'commit&push' = commit 成功后串联 push。commit 成功清空 message。

新增 props：`guardDirtyBuffersThen: () => Promise<boolean>; reloadAllTextTabs: () => void`。

- [ ] **Step 3: workspace.css**——`.git-changes-head`、`.git-branch-chip`（含 ▾ 与计数徽标）、`.git-branch-menu`（absolute z-index bg-elevated border）、`.git-commit-box`（textarea 高 56px）、`.git-commit-actions`、`.git-row-action`（+/− 按钮，opacity .75 hover 1，参照 `.file-tab-close`）、`.git-group-label`（大写小字 muted）。风格与现面板一致，不新增颜色字面量（用既有变量）。

---

### Task 9: 接线（ProjectFiles/Sidebar/App）+ e2e

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/ProjectFiles.tsx`、`components/Sidebar.tsx`、`App.tsx`
- Create: `apps/runtime/test/system-e2e-git.test.mjs`（并登记进 `apps/runtime/package.json` test 脚本清单）

- [ ] **Step 1: 透传 props**：App 把 `guardDirtyBuffersThen`（自 useWorkspaceTabGuard 解构）与 `reloadAllTextTabs`（useWorkspacePanel）经 Sidebar → ProjectFiles → GitChanges 传递（与既有 onOpenDiff 同链路）。
- [ ] **Step 2: e2e 真实二进制链路**（file:// remote 规避网络/凭据）：

```js
// temp repo A：init + commit；bare repo B 作为 origin push -u 完成首推（用 Rust 方法！）
const ctx 直连 SystemRuntimeClient + Store project folderPath=A
dispatch workspace.git_stage {paths:['a.txt']} → 断言 ok
dispatch workspace.git_commit {message:'feat: a'} → 断言 ok；再 dispatch 空暂存 commit → rejects /nothing|no changes/i
dispatch workspace.git_fetch/push（先 git remote add origin file://B，push -u 走 branch 无 upstream 路径）→ B 仓库 git log 可见提交
dispatch workspace.git_branch_create {name:'feature/x', checkout:true} → git_status branch==='feature/x'
脏守卫属前端逻辑，此处仅测 Rust 侧 checkout 回切
```

- [ ] **Step 3: 全量门禁**

```
pnpm format:check / pnpm lint / pnpm typecheck / desktop typecheck / pnpm build:packages
cargo fmt crates --check && cargo test crates && cargo check src-tauri
REFLEXION_SYSTEM_RUNTIME_BIN=… pnpm --filter @reflexion-os-studio/runtime test
```

- [ ] **Step 4: 文档同步**——AGENTS.md：Phase 列表补"Git 写操作（stage/commit/push/branch，方案 A）"；1B 条目"编辑/暂存/提交不在第一阶段"表述更新；docs/ROADMAP.md 对应行更新。spec 影响面核对。

- [ ] **Step 5: 交付说明**——列出 dev 手测清单（真实 remote push 三平台各一次、脏 buffer 切分支全流程、非快进拒绝文案）。
