# Shell 修复计划：登录 Shell 环境 + 沙箱边界（一期）

> 草案，待评审。范围：`crates/system-runtime` 的 shell 执行边界改造 + runtime TS 层与审批链路配套。
> 目标：shell 工具（1）继承用户真实开发环境（登录 shell），（2）在 OS 级沙箱内运行、
> 默认禁网、需要联网时走独立审批，（3）desktop / cli / runtime 三端共用同一实现。
> 决策依据：2026-09-11 分析会话；对照 ReflexionOS（本地同级目录）、codex 官方文档与
> codex-rs 在线源码、opencode 实现。

## 1. 现状与问题

调用链：模型 → [shell.ts](apps/runtime/src/agent/tools/shell.ts)（拼 workspaceRoot + grant）
→ [handlers.rs](crates/system-runtime/src/handlers.rs)（grant 校验 + `paths::resolve_in_workspace`
解析 cwd）→ [shell.rs](crates/system-runtime/src/shell.rs)（POSIX `sh -c` / Windows `cmd /C`，
超时杀进程组）。

| # | 问题 | 现状 | 影响 |
| --- | --- | --- | --- |
| P1 | 环境继承瘦 | Rust sidecar 由 Tauri 宿主 → Node → Rust 层层 spawn（`sidecar_paths.rs` / `system.ts`），不传 env；GUI（Finder/图标）启动链的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` | shell 命令找不到用户安装的工具（nvm / homebrew / conda），报 command not found——即 2026-09-11 确认的现象；git 查找被迫走 `find_git_executable` 候选路径兜底 |
| P2 | 无 OS 级沙箱 | 仅限制初始 cwd（workspace 相对路径 + 符号链接边界），`sh -c` 内部可 `cd`、任意读写、出网 | 工作区边界只是流程性约束（审批 grant），非 OS 强制 |
| P3 | 网络无管控 | 任意命令可出网，且无独立审批抓手 | 数据外传 / 意外副作用风险 |

补充说明：`find_git_executable`（`git/exec.rs`：`REFLEXION_GIT_PATH` → PATH → 平台候选）是
兜底逻辑而非根因；P1 修复后它仍保留，但基本不会再走到候选探测。

## 2. 目标与非目标

一期目标：

1. **登录 shell 环境**（macOS/Linux）：探测用户登录 shell 并以 `-l -c` 执行命令；
   Windows 维持 `cmd /C`（Windows 用户级环境变量 GUI 进程天然可见，无登录 shell 概念）。
2. **macOS Seatbelt 沙箱**：默认 deny 网络；workspace + 临时目录可写；deny 敏感路径
   （`~/.ssh`、`~/.gnupg`）；`sandbox-exec` 不可用时降级放行并显式上报状态（不静默）。
3. **网络审批**：`requires_network` → 独立审批卡（once / session）→ grant；复用现有
   approval 管线。
4. **三端共享**：改动收敛在 `crates/system-runtime`（探测、执行、沙箱）与 runtime TS
   薄层（参数、审批接线、状态展示），CLI / runtime 直连自动受益。

非目标（推迟到二期，本文只留决策位）：

- Linux（bubblewrap）/ Windows（受限 token）沙箱实现与排期。
- 沙箱从"allow default + deny 红线"收紧为 codex 式 deny-default 严格模式。
- 环境快照缓存（登录 shell 每命令付出 zprofile 加载成本；实测过慢再引入）。

## 3. 参照实现对照

| 维度 | codex | ReflexionOS（本地 `../ReflexionOS`） | opencode（本地 `../opencode`） | 本项目一期 |
| --- | --- | --- | --- | --- |
| shell 选择 | `getpwuid_r` 读用户登录 shell + which + 平台兜底（`codex-rs/shell-command/src/shell_detect.rs`） | 直接系统 shell | `$SHELL` 优先 → `/bin/zsh`（macOS）/ git-bash（Windows）黑名单过滤（`src/shell/shell.ts`） | `$SHELL` → `getpwuid` → 平台兜底，进程内缓存 |
| 环境继承 | 登录模式 `-lc`（`core/src/shell.rs`） | conda base env hook 注入 | 继承 `process.env` | 登录 shell 自行补全，不主动覆盖 env |
| 沙箱 | macOS Seatbelt 开箱即用；Linux bwrap（缺则 bundled helper + 启动警告）；Windows 原生沙箱/WSL2 | factory 按平台顺序（win → Seatbelt → bwrap），不可用返回 NullSandbox 放行 | 无 OS 沙箱（权限判定 + 审批） | Seatbelt provider + Noop 降级 + 状态上报 |
| 沙箱策略 | `read-only` / `workspace-write` / `danger-full-access` + `writable_roots` | allow default + deny 网络/系统写/敏感路径（`seatbelt_profile.py`） | — | 一期 allow default + deny 网络/敏感路径；二期评估严格模式 |
| 网络 | 沙箱内禁网，越界走审批 | `requires_network` 参数 → 主动网络审批（`shell_tool.py`） | — | 同 ReflexionOS 模式 |

## 4. 方案设计

### 4.1 登录 shell（对应 P1）

- 新模块 `crates/system-runtime/src/user_shell.rs`：
  - 探测顺序：`$SHELL`（校验文件存在且在允许名单）→ `libc::getpwuid_r`（对齐 codex，
    避免 `getpwuid` 的线程安全问题）→ `/bin/zsh`（macOS）/ `/bin/bash`（Linux）→ `/bin/sh`；
  - 探测结果 `OnceLock` 进程内缓存，避免每命令重复探测；
  - 执行改为 `Command::new(shell).args(["-l", "-c", command])`；
    Windows 分支维持 `cmd /C` 不动。
- 不主动覆盖 env：子进程继承 sidecar 环境，由登录 shell 的 zprofile/zshrc 补全
  （与 codex 一致）。`shell.rs` 现有超时 / 输出上限 / 进程组树杀语义不变
  （登录 shell 同样落在新进程组，`kill(-pgid)` 连子进程一起回收）。
- 已知取舍（记录，不阻塞）：`~/.zshrc` 的 echo 输出会混入 stdout；nvm 等 hook 拖慢
  启动（约 100ms–1s/命令）。缓解：工具 description 提示；二期可选"首命令 dump env
  快照、后续直接注入"。
- 测试：探测顺序与缓存单测；`-lc` 参数拼装单测；现有 `shell.rs` 测试保持通过。

### 4.2 Seatbelt 沙箱（对应 P2）

- 新模块 `crates/system-runtime/src/sandbox/`：
  - `mod.rs`：`SandboxProvider` trait（`is_available()` / `wrap(...)`）+ 工厂；
    不可用返回 `NoopSandbox` 并置 degraded 标记（对齐 ReflexionOS `NullSandbox`）；
  - `seatbelt.rs`：生成 profile，以
    `/usr/bin/sandbox-exec -p <profile> -- <login-shell> -l -c <command>` 执行；
  - 一期 profile 策略（deny-based，参照 `seatbelt_profile.py`）：
    - `(allow default)`——保持开发工具链可用；
    - `(deny network*)`——核心红线：默认禁网；
    - `(deny file-read* (subpath "/Users/*/.ssh"))`、`.gnupg` 等敏感路径；
    - `file-write*` 仅允许 workspace root 与进程 TMPDIR。
  - 可用性判定：macOS 且 `/usr/bin/sandbox-exec` 存在；被 MDM/安全软件拦截时以
    实际执行失败归类为不可用（见 4.4）。
- 协议扩展：`shell.execute` params 增加 `allowNetwork: boolean`（缺省 false）；
  result 增加 `sandbox: { active: boolean }` 便于 UI 展示与排障。
- `handlers.rs`：`allowNetwork=true` 时校验 grant 中带网络放行声明（见 4.3），
  未带则返回结构化错误（`network_approval_required`），由 TS 层转为审批卡。

### 4.3 网络审批（对应 P3）

- TS 工具层（`apps/runtime/src/agent/tools/shell.ts`）：参数增加
  `requires_network: boolean`；description 提示"需要联网（npm install / git push /
  curl 等）时置 true，否则沙箱内必失败"。
- 权限接线（`permissions.ts` / `tool-policies.ts`）：`requires_network=true` →
  生成 `approval.required`（permission `sandbox_network`，scope once / session）
  → 审批卡 → ApprovalGrant → 执行；完全复用现有 approval 管线。
- grant 校验（`crates/system-runtime/src/grant.rs`）：operation 仍为 `shell.execute`，
  grant payload 增加 `sandboxNetwork` 声明；Rust 侧核对请求的 `allowNetwork` 与
  grant 一致，防止前端绕过。
- 会话级放行：scope=session 时本会话后续网络命令免审批（对齐 ReflexionOS
  `SessionTrustStore` 行为）。

### 4.4 状态上报与降级观测

- `system.ready` / runtime.status 增加沙箱能力位：`sandbox: "seatbelt" | "none"`；
  前端会话页可见当前沙箱状态，`none` 时提示"命令未沙箱化，仅保留路径边界与审批"。
- 执行失败分类（参照 ReflexionOS `error_detector` 思路）：sandbox-exec 不存在 /
  启动失败 / profile 拒绝，分别映射为可读错误与降级决策，不静默吞掉。

## 5. 实施步骤与验收

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| S1 | `user_shell.rs` 探测 + `-lc` 执行改造（Rust） | cargo test 全绿；Finder 启动 desktop 后 `echo $PATH` 能看到 nvm/homebrew 路径，用户工具可执行 |
| S2 | SandboxProvider + seatbelt profile + 协议扩展 | 无网络审批时 `curl` 被拒；workspace 内读写正常；读 `~/.ssh` 被拒；`sandbox-exec` 缺失时降级为 `sandbox:"none"` 且状态可见 |
| S3 | `requires_network` + 网络审批闭环 | `npm install`（未审批）触发审批卡；allow once 后执行成功；session 放行后不再询问；无 grant 的 `allowNetwork` 被 Rust 拒绝 |
| S4 | 状态上报 + 前端展示 + 错误分类 | ready/status 带 sandbox 位；UI 可见沙箱状态与降级提示 |
| S5 | 文档与回归 | `AGENTS.md`、`PERMISSION-MODEL.md` 增补；现有 shell/审批测试全绿；desktop / cli / runtime 直连三端冒烟 |

## 6. 风险与开放问题

- **profile 宽松度**：一期 allow default 弱于 codex 默认严格模式；红线是禁网 + 敏感
  路径 deny，二期评估 deny-default（对齐 codex `workspace-write`）。
- **登录 shell 副作用**：zshrc 输出污染 stdout、启动延迟；接受并在工具描述中提示，
  二期环境快照缓存作为可选项。
- **sandbox-exec 被拦截的机器**：降级 none + 显式提示，不静默放行。
- **Linux / Windows 沙箱排期**：未定；Windows 一期维持 `cmd /C` + 现状。
- **codex 参照精度**：本地无 codex 源码，以官方文档（`developers.openai.com/codex`
  sandboxing/security）+ GitHub raw 源码核对；后续引入本地仓库可复核细节。

## 7. 已确认决策记录

- 环境策略：**登录 shell（`-l -c`）**（2026-09-11 确认，弃环境快照为二期可选项）。
- 网络审批：**进一期**（2026-09-11 确认）。
- "先查找系统环境"现象根因：**shell 命令因瘦 PATH 找不到命令**（2026-09-11 确认，
  非 git 兜底探测）。
- 沙箱落点：`crates/system-runtime` 统一实现，三端共享。
- 一期平台范围：macOS 沙箱 + 其他平台降级放行（待最终确认）。
