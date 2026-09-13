# Git 提交历史 + 远程管理设计（方案 A 增补批）

日期：2026-09-12
状态：范围已确认（历史 a+b、远程 a；破坏性动作一律不做）
前置：方案 A（stage/commit/push/branch 写操作）已交付；本批补两块缺口且不改写命令面。

## 范围

**做**：仓库级提交历史（只读列表 + 分页 + 每 commit 改动文件 + 点文件看 commit↔parent diff）、从 commit 检出（detached 导航）/ 基于 commit 建分支、远程列表（name+URL，回显剥凭据）/ 添加 / 移除 remote、远程分支列表与"检出为本地跟踪分支"、发布当前分支（复用 push 自动 -u）。

**不做**：revert/reset/amend/cherry-pick、删远程分支、force-push、graph DAG 可视化、文件级历史（file log）、单提交详情页（用右侧 diff 标签代替）。

## 决策记录

| 决策点                     | 结论                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit diff 通道           | 新命令返回 `{original, modified}` 全文对，前端走既有 `openDiff(path, {source:'chat', before, after})` 字符串通道 → **零改 DiffViewer/FileViewerPanel**                                                                                                                 |
| hash 边界                  | 所有接受 commit 标识的参数一律 `^[0-9a-fA-F]{4,64}$` 严格校验（Rust+runtime 双层）；rev-spec（`HEAD~3`、`@{u}`、含 `^` `:` `~` 的串）拒绝——导航需要"任意 rev"的场景不存在，列表给的就是 hex                                                                            |
| checkout commit            | 复用 `git.branch_switch`：detached 检出（校验放宽为 分支名 **或** hex）；前端入口文案「检出此提交（进入分离头指针）」                                                                                                                                                  |
| 基于 commit/远程分支建分支 | `git.branch_create` 增可选 `startRef`：hex **或** `remote/branch` 形态（仅做**形态安全**校验：字符白名单、无前导 `-`、无控制字符——不校验首段是否真实 remote，不存在的 ref 交给 git 报错清晰化）；`checkout -b <name> <startRef>` git 自动建立 tracking（VS Code 同款） |
| 远程 URL 安全              | `git remote -v` 输出回显前剥除 userinfo 段（`scheme://user:token@host` → `scheme://***@host`）；添加时原样写入 git 配置（用户自己的配置，不入库不外传）                                                                                                                |
| remote add URL 校验        | 白名单形态：`https://…`、`git@host:path`、`ssh://…`、`file://…`（测试用）；拒绝前导 `-`、控制字符、空白；name 复用 validate_branch_name                                                                                                                                |
| 远程删除范围               | 只删本地 remote 配置（`git remote remove`），弹 ConfirmDialog；不碰任何远端数据                                                                                                                                                                                        |
| 分页                       | log `--skip --max-count`（页 50），`hasMore` = 取满即疑有；不做 --graph                                                                                                                                                                                                |
| 空仓库                     | `does not have any commits yet` → `repo:true, commits:[]`；非仓库 → `repo:false`                                                                                                                                                                                       |
| merge commit               | `isMerge`（parents>1）标记；其 diff = 对第一父（业界默认展示，文案注明）                                                                                                                                                                                               |

## 命令面

### Rust 协议（system-runtime，新增只读为主）

| 方法                   | argv                                                                                         | 出参                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `git.log`              | `--no-pager log --pretty=format:%H%z%h%z%at%z%an%z%P%z%s%z --skip=N --max-count=M`（%z=NUL） | `{repo, commits:[{hash, shortHash, timestampMs, authorName, isMerge, subject}], hasMore}`；records 按 `\n` 切、fields 按 NUL 切 |
| `git.commit_files`     | `--no-pager show --name-status -z --format=` <hex>                                           | `{files:[{status, path, oldPath?}]}`；R/C 三字段（含 score）、-z NUL 流解析；status 词表对齐现有 GitChangeStatus                |
| `git.commit_diff`      | 复用 diff.rs 机制：base `<hex>^:./path`、head `<hex>:./path`                                 | DiffOutcome（original/modified/truncated/binary）                                                                               |
| `git.remotes`          | `remote -v`（fetch 行）                                                                      | `{remotes:[{name, url(masked)}]}`                                                                                               |
| `git.remote_add`       | `remote add <name> <url>`                                                                    | `{ok:true}`                                                                                                                     |
| `git.remote_remove`    | `remote remove <name>`                                                                       | `{ok:true}`                                                                                                                     |
| `git.branches`（扩展） | 增加 `for-each-ref refs/remotes`（剔除 `*/HEAD`）                                            | `{…, remoteBranches:[string]}`                                                                                                  |

写命令扩展：`git.branch_switch` 接受 hex（detached checkout）；`git.branch_create` argv 追加可选 startRef（`branch <n> [ref]` / `checkout -b <n> [ref]`）。全部沿用既有 async 分发、错误码、`--no-pager`、超时档；变更类（remote add/remove/branch_*）走 withGitQueue。

### Runtime `workspace.git_*`

`git_log {skip?, limit?}` / `git_commit_files {hash}` / `git_commit_diff {hash, path}` / `git_remotes` / `git_remote_add {name, url}` / `git_remote_remove {name}`；`git_branch_create` 参数增 `startRef?`。hex/url/name 校验 runtime 先行（错误码 invalid_request），Rust 兜底。白名单经 contracts 自动生成。

### 契约（先改）

commands.ts 6 新命令 + `git.branches`/`git_branches` result 增 `remoteBranches` + `workspace.git_branch_create` 增 `startRef`。commit_diff result 复用 git_diff 形态。

## 前端

### ProjectFiles 新增「历史」tab → `GitHistory.tsx`

```
┌ 提交历史（当前分支 HEAD）        [刷新] ┐
│ ✎ feat: add history panel             │  subject 单行省略
│   张三 · 2 小时前 · a1b2c3d        ⋯  │  ⋯ 菜单：复制哈希/基于此建分支/检出此提交
│   └（展开）M src/a.ts  R old→new      │  行点击=展开文件列表（懒取 commit_files）
│ ─ 加载更多（skip+50） ─               │
└───────────────────────────────────────┘
```

- 文件点击 → `onOpenDiff(path, {source:'chat', before:original, after:modified})`（复用现通道）。
- 「检出此提交」「基于此建分支（checkout 选项默认勾）」→ 先 `guardDirtyBuffersThen()`，成功后 `reloadAllTextTabs()` + 刷新 status/branches/log（与方案 A 的守卫链完全一致，经 ProjectFiles 透传，同 GitChanges 三跳）。
- 相对时间：`git-time.ts` 纯函数（分/时/天/周/直接日期），无新依赖。
- 非仓库/空仓库/加载/错误态：沿用 git-hint 家族样式。

### BranchPicker 扩展

菜单内分区：本地分支（现状）→ **远程分支**（`origin/x` 列表，点击 → 打开"新建本地分支"预填名 + startRef=`origin/x`）→ **远端**（`origin  https://***@github.com/…` 行 + 移除按钮；底部「添加远端」表单 name+url）。发布=芯片旁现有「↑推送」按钮（无 upstream 自动 `-u origin` 已在方案 A 实现）。远程分支增删改后回调刷新 branches。

### CSS

`.git-hist-*`（行/元信息/展开文件）、`.git-branch-section`（分区标题）、复用 git-badge/git-list 基座；只用既有变量。

## 错误处理与刷新

- 读命令失败：面板内联错误条（同 I-2 分类法，log 特有无新增模式）。
- 每次变更后：status+branches+log 首屏一起刷新（历史面板复用 onAfterMutation→badges 刷新的同链路）。
- commit_files/commit_diff 并发点击：per-hash 内存缓存（Map，随分支操作清空）。

## 测试

- Rust：log 解析（含 merge/中文作者/空格 subject）、commit_files rename 三字段、commit_diff 前后内容与首父语义、remotes 凭据剥除与 URL/name 校验拒绝面、branch_switch 接受 hex/branch_create startRef 真仓往返；非仓库/空仓库两态。
- runtime：6 新命令 fake-system 参数/校验/队列断言；`git_branch_create startRef` 透传。
- e2e 真二进制：commit 后 git_log 有增量 → git_commit_files → git_commit_diff 前后断言 → 基于远程分支建本地跟踪分支（file:// remote 往返）→ detached checkout 后 status.branch=null。
- 前端：typecheck/lint + dev 手测清单（本仓库自测：真实 remote 添加/移除/发布/远程检出走一圈）。

## 跨平台

- 全链 git CLI（复用 find_git_executable/超时/非交互 env）；`--format=%z`/NUL 解析无平台差异；CRLF 无关（读对象不读工作树）。
- macOS GUI 链局限不变：SSH remote 添加无碍、推送凭据仍可能失败（既有已记录限制，本批不新增）。

## 影响文件（预估）

Rust：`git/log.rs`（新）、diff.rs（commit 侧查询）、remotes 并入 service 或 `remote.rs`（新）、writes.rs（switch/create 扩展）、params/handlers/main + 各测；contracts commands.ts；runtime workspace/handlers.ts + git-queue 复用 + handlers.test；前端 `GitHistory.tsx`、`git-time.ts`（新）、BranchPicker/ProjectFiles/api/workspace.css；文档 AGENTS/ROADMAP 更新一句。

**行数纪律**：handlers.rs 已 576 行（Rust）——本批触碰它时按计划拆出 `handlers_git.rs`（AGENTS §4 发现超纲当次拆）。GitHistory ≤300。

## 实现修订（交付时与上文决策的差异，评审驱动）

- **`git checkout` → `git switch` / `switch --detach`**（评审 I-1）：`git checkout <rev>` 在 rev 非 ref 且仓库恰有同名被跟踪文件（如 `v1.2`）时回退为 pathspec 模式，会静默丢弃该文件的磁盘修改（数据丢失攻击面）。branch_switch 与 branch_create 检出路径全部改为 ref-only 的 `switch`（hex → `switch --detach`），非 ref 即 fatal "invalid reference" 且工作树不受影响；上文 "`checkout -b <name> <startRef>`" 相应为 `switch -c <name> <startRef>`，tracking 自动建立语义不变（branch.autoSetupMerge 默认）。
- **URL 掩码最终规则**：`scheme://` 形态且 authority 带 userinfo 时，scheme 为 http/https（GitHub 惯例把裸 token 放 user 段，`https://TOKEN@host` 无冒号也必须遮蔽）或 userinfo 含 `:`（任意 scheme 带密码形态）→ 整个 userinfo 替换为 `***`；username 恰为 `git`（`git@host:path`、`ssh://git@host`）非机密原样保留；无 scheme 的 scp 形态无法携带密码，原样返回。
- **移除 remote 采用两步确认**（R4 决策）：行内点击「移除」→ 该进入确认态（按钮变「确认移除」+ 可取消），再点才发命令；不套三层 ConfirmDialog 模态。远端数据本就不被触碰，误点成本低于弹窗打扰。
- **commit_diff 的 `binary`/`truncated` 经 `openDiff` 透传**（H 评审 I-2）：DiffViewer 标签与只读提示需要知道二进制/截断态，`{original, modified, binary, truncated}` 全量传给既有字符串通道，查看器按 flag 显示提示而非渲染补丁文本。
