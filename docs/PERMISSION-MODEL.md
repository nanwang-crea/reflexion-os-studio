# Permission Model

本文件描述 **权限模型 V2**（Codex 风格）。设计全文与分阶段任务见仓库根设计稿；本文是落地后的稳定契约说明。核心不变量：**权限决策（是否要问）与 OS 沙箱（获批后能碰什么）正交**；审批只能在硬边界内扩权，任何档位/提权/Danger 都不得旁路 no-read 机密清单与工作区根保护。

## 1. 三档日常权限预设（PermissionPreset）

替代旧的 `permissionMode`（workspace / read-only）+ `trusted` 双轨，合并为单一枚举：

```ts
type PermissionPreset = 'workspace-read' | 'workspace-write' | 'workspace-full'
```

| 档位              | 读取/list/glob/grep | write/edit/mkdir | move      | delete    | Shell 默认           | 工作区外       |
| ----------------- | ------------------- | ---------------- | --------- | --------- | -------------------- | -------------- |
| `workspace-read`  | automatic           | ask              | ask       | ask       | ask                  | ask escalation |
| `workspace-write` | automatic           | automatic        | automatic | ask       | rule/ask             | ask escalation |
| `workspace-full`  | automatic           | automatic        | automatic | automatic | automatic in sandbox | ask escalation |

- **默认值保守**：缺省与 legacy 迁移都回落到 `workspace-read`，升级不静默扩大写权限。
- `workspace-read` 不是旧的 `read-only`（denied）语义：写/Shell 会**询问**，而非直接拒绝。
- `workspace-full` UI 可显示"完全允许"，但辅助说明必须写"仅工作区内"；它**不等于无沙箱**，也不自动打开网络。
- **无工作区会话**：`file.*` 一律拒绝；Shell 只能通过显式提权请求进入审批。

`workspace-full` 的凭据仍走 Rust `require_grant`，只是决策为 automatic 时 Runtime 以 `preset` source 签发精确 grant。

## 2. 高级审批覆盖项（ApprovalOverride）

"所有操作均询问"不占日常下拉，而是**会话级内存覆盖项**：

```ts
type ApprovalOverride = 'default' | 'ask-everything'
```

`ask-everything` 下读取/写入/删除/Shell 全部进入 ask；硬拒绝仍为 denied。仅当前会话生效、不持久化。命令：`permission.approval_override.set/get`。

## 3. 高级 Danger 能力（session lease）

Danger 不属于 `PermissionPreset`，是需要单独启用的**高风险会话租约**，两段式确认：

```
danger.prepare({sessionId}) -> {challengeId, expiresAt, warning, capability}   # challenge ≤60s、单次消费、绑定 session
danger.enable({challengeId, acceptedRisk:true}) -> {lease}                     # 校验平台 capability 后签发 ≤30min 内存 lease
danger.disable({sessionId}) -> {disabled}
```

- 生命周期事件 `danger.changed`（session 作用域，携带 lease/reason）驱动 UI 常驻红色状态条与倒计时。
- 生效后：工作区内外普通文件与 Shell 不再逐次审批、Shell 网络不再单独审批；但 **no-read、Provider secret、日志脱敏、进程树回收仍生效**；`file.*` 仍是工作区相对契约，系统范围访问通过 `shell.execute` 走 `danger` 沙箱档。
- lease 不进消息参数、不由模型控制、不随队列项复制；会话删除 / Runtime 重启 / 到期 / provider 降级 / guard 自检失败 → 立即撤销。
- **完成定义**是"最大非敏感系统访问 + credential-guard"，`DangerAccessLease.enforcement` 只有 `credential-guard` 一种，禁止裸 `NoopSandbox`。
- **三平台**：macOS Seatbelt（放开非敏感读写/网络、保留敏感 deny）、Linux bwrap（放开非敏感根/网络、保留敏感 mask）、Windows **必须**有可验证凭据拒读机制，否则 Danger fail-closed（`danger_capability_unavailable`），且不得标记为三平台完成。

## 4. 沙箱档位与权限决策分离

```ts
type SandboxPolicy = 'read-only' | 'workspace-write' | 'escalated' | 'danger'
```

Preset → Shell 默认 SandboxPolicy：`workspace-read→read-only`、`workspace-write→workspace-write`、`workspace-full→workspace-write`。一次审批 choice 必须显式声明携带的 sandbox 能力；访问工作区外用 `escalated`。任一平台无法可靠应用所选 access 时 **fail-closed**，不得降级为无沙箱后继续执行。

## 5. 审批主题、choice 与会话规则

### 5.1 ApprovalSubject（Runtime 构造，模型不可提供）

`z.discriminatedUnion('kind', ...)`：`operation`（MCP/其它，operation 级）、`workspace-path`（operation + 规范化相对路径）、`shell-command`（commandDigest + displayCommand + prefixCandidate? + escalation + network）。授权身份用 digest 与结构化规则，`displayCommand` 仅 UI、脱敏限长。

### 5.2 choice 驱动

`approval.required` 增加 `subject / risk / context / choices`（均为兼容历史回放而可选，live 审批由 Runtime 保证全量下发）。`ApprovalChoice = {id, decision, presentation, label, description?}`，`presentation ∈ primary / session-menu / secondary` 只决定按钮位置，**不携带授权 effect**。`approval.resolve` 只接受 `{requestId, toolCallId, choiceId}`；Runtime 验证 choiceId 属于当前 pending，查服务端保存的真实 effect。旧的 `decision + scope` 不再是权威输入。

### 5.3 会话规则（内存态，`ApprovalGateway`）

- `workspace-path`：sessionId + workspaceRoot + operation + 精确 path。
- `shell-prefix`：sessionId + workspaceRoot + interpreter + prefix[] + sandbox + network。

规则只在内存：会话隔离、工作区隔离、Runtime 重启失效、`session.delete` 主动清理、切项目不复用、不写数据库/事件/工作区文件。

## 6. 文件工具授权（资源级）

模型仍只传工作区相对路径；Runtime 审批前拒绝绝对路径与 `..`、规范化为协议级 `/`；Rust 继续 canonicalize、符号链接逃逸与最终 workspace 边界；grant 保存 `subjectDigest`，Rust 按 operation + 规范化相对路径重算比对。各工具的 session choice：

| 工具          | 会话 choice                   | 说明                        |
| ------------- | ----------------------------- | --------------------------- |
| `file.read`   | 本会话允许读取此文件          | 精确 path                   |
| `file.list`   | 本会话允许列出此目录          | 精确目录，不递归授权子树    |
| `file.glob`   | 本会话允许本次 pattern        | 不扩大为全工作区读取        |
| `file.grep`   | 本会话允许本次 path/glob 范围 | 不把搜索文本写进 key        |
| `file.write`  | 本会话允许写入此文件          | 先读后写仍生效              |
| `file.edit`   | 本会话允许读取并编辑此文件    | 原子生成 read + edit 两规则 |
| `file.mkdir`  | 本会话允许创建此目录          | 精确 path                   |
| `file.move`   | 不提供通用 session choice     | from/to 一次性审批          |
| `file.delete` | 不提供 session choice         | 前三档逐次审批；full 自动   |

## 7. Shell 命令前缀与会话规则

`shell.execute` 参数扩展：`sandbox_permissions: 'use_default'|'require_escalated'`、`justification?`、`prefix_rule?`。`require_escalated` 必须携带非空 justification（`ShellExecuteParamsSchema` refine）。

本期只为**简单单命令**生成 session prefix choice；出现多命令/控制符（`;` `&&` `||` `|` 换行 `&`）、重定向、命令替换、`eval`/`exec`/`sh -c`/`bash -c`/`cmd /C`、无法闭合引号、环境变量前缀、动态可执行名等任一形态时**只允许一次**。前缀匹配基于 **token**（禁止 `startsWith`），至少含可执行文件 + 一个稳定子命令；`git push --force`/`reset --hard`/`clean`/删除类只允许一次；deny/always-ask 优先于 session allow；cwd/sandbox/network/interpreter 参与 rule identity，read-only 规则不得在 write/escalated 执行中复用。

分类器解释器：macOS/Linux `/bin/sh -c` → POSIX tokenizer；Windows `cmd.exe /C` → cmd tokenizer。PowerShell 不属本期执行器。若未来 `sh`→`bash`，分类器与执行器必须同批切换并回传实际 interpreter。

## 8. Grant V2 与网络绑定

所有来源（once / session-rule / preset / danger-lease）都为当前实际请求签发短期 `ApprovalGrantV2`：`{version:2, grantId, requestId, sessionId, workspaceId, operation, source, subjectDigest, sandbox, sandboxNetwork, expiresAt}`。Rust 依实际请求重算 digest 复核；session rule 只决定"是否免问"，不得把旧 grant 原样复用给新命令。

网络：once 批准只进当前精确调用 grant；session 复用要求命中同一 `shell-prefix` rule 且 `network=true`；无 prefix 的复合命令不得创建 session 网络授权；`workspace-full` 仍需首次网络审批；有效 Danger lease 自动放行网络但 grant 显式记录 `sandboxNetwork=true`；Rust 在 `allowNetwork=true` 时继续复核 `sandboxNetwork=true`。

## 9. 永久硬拒绝（优先于 preset / session rule / escalation / Danger）

AGENTS.md 第 12 节 no-read 清单；Provider secret 及 `secretRef` 原值、数据目录 `secrets.json`；工作区根删除；绝对路径 / `..` / 符号链接逃逸；未声明网络；无效/过期/资源不匹配/命令不匹配的 grant。`require_escalated` 只扩展本次命令允许访问的非敏感路径，不关闭敏感拒读与日志脱敏。

## 10. 兼容与迁移

- 协议 `PROTOCOL_VERSION` 从 `1.1` 提升到 `1.2`（TS 与 Rust 同步）；握手不一致 fail-closed。
- 开发态旧前端混用：未提供 `permissionPreset` 回落 `workspace-read`；一版本内兼容读取 legacy `permissionMode/trusted`（workspace/read-only→workspace-read、trusted=true→workspace-full），新字段优先，下一协议版本删除 legacy。
- localStorage 由前端一次性迁移到 `reflexion.permission-preset.v2`，失败回落 `workspace-read`。session rules / Queue / Grant 均内存态，无 SQLite migration。

## 11. 稳定错误码

`permission_denied`、`approval_choice_invalid`、`approval_subject_mismatch`、`shell_rule_not_reusable`、`sandbox_escalation_required`、`sandbox_escalation_denied`、`sandbox_policy_unavailable`、`network_approval_required`、`danger_capability_unavailable`、`danger_challenge_invalid`、`danger_lease_expired`。

## 12. 两层职责（不变）

**TS Policy Gateway**：产品层决策——preset 矩阵、ask-everything、subject 构造、session rule、grant 签发、Danger lease 编排；不能让 Rust 越过其硬边界。**Rust Enforcement**：不可绕过的底线——workspace 边界、路径规范化 / `..` / 符号链接、`subjectDigest` 复核、grant 时效与命令匹配、OS 沙箱 access 应用、命令超时、环境过滤、进程树回收、no-read 敏感拒读。

## 13. 审计

记录 permissionPreset、operation、subject 类型与脱敏摘要、choiceId、grant source、shell prefix ruleId、sandbox policy/provider、network/escalated 标志、Danger challenge/lease 的启用/撤销/到期/provider、最终状态与稳定错误码。**不得**记录文件内容、完整敏感命令参数、环境变量值、secret 或 grant JSON。
