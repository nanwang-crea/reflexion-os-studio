# 编辑器 Git 写操作（方案 A：日常最小闭环）设计

日期：2026-09-12
状态：范围与关键决策已逐条确认
前置：GitChanges 只读面（status/diff）与 Rust `git/` exec 基建已就位；ROADMAP 预留"编辑、暂存、提交等 Git 写操作后续须经明确命令与权限策略"即本批兑现。

## 范围

**做**：stage / unstage（单文件 + 全部）、commit（含"提交并推送"）、fetch、push（自动 upstream）、branch 查看 / 新建（可选切换）/ 切换、pull（仅 `--ff-only`）、status 扩展 ahead/behind、脏 buffer 守卫、操作后联动刷新。

**不做（后续批次）**：discard changes、提交历史列表、amend、stash、force push、merge/rebase、agent git 工具（agent 已可经 shell.execute+审批跑 git）、集成终端（独立 ROADMAP 条目，届时作为交互式凭据的逃生舱）。

## 决策记录

| 决策点 | 结论 |
| --- | --- |
| 执行层 | Rust `git/` 模块扩子命令，复用 `run_git` 全部护栏；argv 由 Rust 按命令枚举固定拼装，路径走 workspace 相对校验，**拒绝任意 argv 透传** |
| 权限语义 | UI 按钮 = 用户直接动作，免审批凭据（与 `workspace.write_file` 的 `source:"ui"` 边界一致）；无二次确认层——commit/push 一键即执行（VS Code 同款） |
| push 入口 | GitChanges 面板头部按钮组：Commit 主按钮（⌘/Ctrl+Enter）+ 拆分菜单「提交并推送」+ Push/Sync 按钮；分支芯片点开切换器 |
| 切分支重载 | 磁盘未提交改动交给 git 原生（能 carry 则 carry，冲突则报错展示 stderr）；**内存脏 buffer 是 git 不可见的雷**：切换/pull 前走三键确认（保存全部/放弃/取消），成功后所有文本标签强制从磁盘重载 |
| pull | 仅 `--ff-only`；分歧即失败并把 git 提示原样展示，不自动 merge/rebase |
| 凭据 | 继承用户 git 配置（credential helper / SSH agent），不实现认证 UI；交互防挂起见"跨平台"节 |
| 终端捆绑 | 不捆绑（架构层不同、互相拖累交付；终端是 git 的逃生舱而非前置） |

## 命令面

### Rust 协议（system-runtime，新增）

| 方法 | argv | 备注 |
| --- | --- | --- |
| `git.stage` | `git add -- <paths…>` | paths 非空校验；"全部暂存"由前端枚举路径传入 |
| `git.unstage` | `git reset -- <paths…>` | 用 reset 而非 restore（兼容老 git） |
| `git.commit` | `git commit -m <message>` | message 非空；仅提交已暂存（无 -a）；hooks 由 git 原生执行，失败展示 stderr |
| `git.fetch` | `git fetch origin` | 长超时档 |
| `git.push` | 有 upstream：`git push`；无：`git push -u origin <current>` | current 由 Rust 自查 symbolic-ref，前端不传分支名 |
| `git.pull` | `git pull --ff-only` | 同上网络档 |
| `git.branch_create` | `git branch <name>` / `git checkout -b <name>` | `checkout:true` 时后者；name 服务端校验（`git check-ref-format --branch` 或字符白名单） |
| `git.checkout` | `git checkout <name>` | name 同上校验 |
| `git.status`（扩展） | porcelain=v2 `# branch.*` 头 + `rev-list --left-right --count` | 响应增加 `branch`、`upstream`、`ahead`、`behind`（无 upstream 时 null） |

全部新命令 async 分发（复用 status/diff 的 `(Value, bool)` 线程模式）。错误分类沿用 `git_unavailable / git_failed / timeout` + stderr 关键模式友好化：`no upstream`、`non-fast-forward`、`Your local changes…would be overwritten`、`nothing to commit`。

### Runtime 命令（workspace.git_*）

`workspace.git_stage / git_unstage / git_commit / git_fetch / git_push / git_pull / git_branch_create / git_branch_switch`：解析 projectId → 工作区边界校验（既有 requireWorkspaceProject）→ 转 Rust 协议。`workspace.git_status` 响应透传新增字段。

**并发**：Runtime 侧按 workspaceRoot 串行队列（git index.lock 互斥是硬约束，UI busy 态之外再加一层防呆）；网络命令超时 120s（run_git 现 30s 默认需加操作级覆盖）。

### 契约（contracts 先行）

commands.ts 新增 8 个 `workspace.git_*` schema：params 为 requestId/projectId/paths?（stage/unstage 必填非空）/message?（commit 必填非空）/name?（branch 类必填）/checkout?；**全部变更类 result 统一 `z.object({ ok: z.literal(true) })`**（成功与否靠 result/error 区分，无 summary——前端成功即刷新 status 取真实状态），`workspace.git_status` result 增加 branch/upstream/ahead/behind 四字段。Tauri `RUNTIME_METHODS` 白名单同步登记。

**fetch 触发策略**：不占用按钮——面板打开、任一 git 操作成功后后台静默 fetch（失败静默，ahead/behind 是"尽力而为"的指示器）；push 不做 fetch 预检，非快进由远端拒绝兜底。

## 前端 UI（GitChanges 面板重构，VS Code SCM 布局）

```
┌ 分支芯片 ⑂ feature/x ↑2 ↓0 ▾ ──────── [↓更新] [↑推送] ┐  ← 头部行（更新= pull --ff-only）
│ 提交信息 textarea（⌘/Ctrl+Enter 提交）                 │
│ [✓ 提交] ▾（拆分菜单：提交并推送）                     │
├ 变更文件列表（现有 git-list 增强）─────────────────────┤
│  M src/a.ts            [−]（unstage）/ [+]（stage）    │
│  ?… 未跟踪 …  头部：全部暂存 / 全部取消                │
└────────────────────────────────────────────────────────┘
```

- 分支芯片下拉：分支列表（现有 `git_branches` 数据）+「新建分支」输入（含"创建并切换"开关）。
- 忙态：任一 git 操作进行中禁用全部 git 按钮 + 面板 spinner；结果反馈成功静默（列表刷新即反馈），失败把分类后的 stderr 进面板内联错误条（复用 `git-hint-error` 风格）。
- 空态：`repo:false` 保持现状提示；非 git 目录不出现按钮组。

## 脏 buffer 守卫与刷新联动

1. **切换前**（checkout/pull 共用，stage/commit/push 不需要）：`dirtyPaths` 非空 → 三键弹窗「保存全部并切换 / 放弃并切换 / 取消」。**实现方式**：`useWorkspaceTabGuard` 增加导出 `guardDirtyBuffersThen(): Promise<boolean>`（现有 `guardedResetWorkspaceFiles` 重构为其上薄封装 + `resetWorkspaceFiles()`，弹窗文案与保存全部逻辑复用现有实现），GitChanges 侧经 props 注入该守卫。保存失败则中止。
2. **成功后**：
   - `reloadAllTextTabs()`：`useWorkspacePanel` 新增动作，bump 全部内容/Markdown 标签 nonce；`FileViewerPanel` 保活 key 改为 `path#nonce`，触发 surface 重挂载 → 从磁盘重读 → `workspace.read_file` 登记新凭据。守卫保证此刻无脏 buffer，重载零损失。
   - 刷新 `git_status` + `git_branches`；stage/commit 不重载（工作树未变）；commit 后清空 message 输入。
3. indexer：checkout/pull 改变文件后根目录 mtime 变化 → 既有 stale 推导自动生效，不新增联动。
4. 竞态：守卫→执行 git 之间若有新保存/编辑发生，checkout 后统一 reload 兜底（脏状态已由守卫清零，唯一窗口是守卫后编辑——三键确认会先保存/清空，重编辑不可能发生在 modal 期间，面板禁用 + 串行队列兜底剩余路径）。

## 跨平台（红线 8）

- **交互凭据防挂起**：网络命令 env 注入 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=`（空）；git 因缺凭据失败时 stderr 原样分类展示，引导文案提示"请在终端或安装凭据助手后重试"。Windows GCM 可能弹系统窗——属用户可感知行为，保留。
- **macOS SSH 局限（如实记录）**：GUI/launchd 启动链无 `SSH_AUTH_SOCK`，SSH remote 推送可能失败；HTTPS+helper 正常。`launchctl getenv SSH_AUTH_SOCK` 注入方案与集成终端一并属后续批次，本期在错误提示中明示该可能。
- git 可执行查找复用 `find_git_executable`（三平台 + `REFLEXION_GIT_PATH`）；路径参数一律 `--` 分隔 + 相对校验，Windows 反斜杠路径由既有 `assertRelativePath` 归一。
- LF/CRLF：提交行为完全交给用户 git 配置（autocrlf），本功能不做换行干预。

## 错误处理

- 命令级：GitError → CommandError → 面板内联条；串行队列保证同刻单操作、无交错状态。
- `nothing to commit`（commit 空暂存区）：前端预检禁用 + 服务端兜底文案「没有已暂存的变更」。
- push non-fast-forward：分类文案「远端有新提交，请先同步」，不给 force 出口（本批有意不提供）。
- checkout 被 git 拒绝（本地改动重叠）：stderr 原文进错误条，指引先提交/暂存。

## 测试与验证

- **Rust**：argv 拼装单测（每条命令、路径含 `..`/空格/`--` 注入尝试必拒）、status v2 分支头解析（ahead/behind/无 upstream 三态）、check-ref-format 分支名校验。
- **Runtime**：8 命令 handler → fake system 参数断言（paths/message/name 透传形状）；串行队列单测（并发两个命令 → file.write 式顺序断言）；status 新字段透传。
- **前端**：typecheck/lint；无自动化 UI 测试设施（既有现实）。
- **e2e（真实二进制）**：临时仓库跑通 stage→commit→(bare repo remote) push→branch_create→checkout→pull --ff-only 全链路 + 脏 buffer 守卫的 Runtime 侧断言；凭据用 file:// remote 规避网络。
- 门禁：AGENTS.md 标准序列全跑；dev 手测清单随计划给出（三平台各测 push 错误路径）。

## 影响面（预估）

| 层 | 文件 |
| --- | --- |
| contracts | `commands.ts`（8 命令 + status 扩展） |
| Rust | `git/service.rs`、`git/status.rs`（ahead/behind）、`git/mod.rs`（子命令拼装）、`handlers.rs`（分发 + async）、`git/exec.rs`（超时档 + env 注入）；单测 |
| runtime | `workspace/handlers.ts`（新命令 + 串行队列）、command-coverage |
| Tauri | `RUNTIME_METHODS` 白名单 |
| 前端 | `GitChanges.tsx`（重构为 SCM 面板）、`api/workspace.ts`、`useWorkspacePanel.ts`（reloadAllTextTabs）、`FileViewerPanel.tsx`（key bump）、守卫 hook 扩展、`workspace.css` |
