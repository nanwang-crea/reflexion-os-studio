# 会话级信任开关（Trusted Mode）设计

日期：2026-09-07
状态：已与用户确认设计方向（方案 A），待实现

## 目标

用户在会话内开启"完全允许"后，该会话后续发送的 Run 不再对文件写入与 Shell 弹审批卡，避免逐个点击确认。

## 决策记录（用户已确认）

1. **覆盖范围**：`file.write/edit/delete/move/mkdir` + `shell.execute` 自动放行。MCP 工具保持 ask（外部进程，不在本次范围）。
2. **Shell 边界如实标注**：shell.execute 无法真正限制在工作区内（Rust 只强制文件路径边界），信任开关 UI 必须明确告知"Shell 命令不受工作区限制"，不假装有边界。
3. **归属与生命周期**：开关是**会话级临时状态**；UI 上并入 Composer 权限下拉第三档（"完全允许"，与工作区读写/只读互斥单选）。工作区读写/只读两档照旧持久化在 localStorage；"完全允许"档不持久化，刷新/重启后回落工作区读写。

## 方案（A：信任标志随消息发送）

复用 `permissionMode` 的现有管道：前端开关 → `message.send` 新增 `trusted` 参数 → Runtime 按 Run 捕获 → PermissionGate 决策。

- 切换只影响之后的发送；运行中的 Run 不变（与 permissionMode 语义一致，可预测）。
- 无新增 Runtime 会话状态、无新命令；排队消息各自携带发送时的 trusted 值。
- run.retry 不携带 trusted（重试按默认审批模式重跑；与现有 retry 不带 permissionMode 的口径一致）。

## 契约变更（packages/contracts）

- `MessageSendParamsSchema` 新增 `trusted: z.boolean().optional()`（默认 false）。
- `QueueEntrySchema` 新增 `trusted: z.boolean()`（toEntry 侧 `?? false`），排队项可见信任状态。
- `PermissionModeSchema` 不动；不新增 Profile 枚举。

## Runtime 变更（apps/runtime）

- `agent/permissions.ts`：`PermissionGate` 构造函数新增第三参 `trusted: boolean`（默认 false）；`decisionFor` 中 trusted 且 hasWorkspace 时，把 workspace 策略表里 6 个 ask 项（file.write/edit/delete/move/mkdir、shell.execute）返回 automatic；read-only 策略不受影响（read-only 与 trusted 同传时以 read-only 为准，trusted 无效果）；MCP/未知工具仍 ask；无工作区仍全 denied。
- `agent/index.ts`：`ChatCommand` 流经 send/startSend/launch 透传 `trusted`；`launch` 构造 gate 时传入；`runPermissionModes` 同款 Map 不需要（trusted 只在 gate 构造时消费，子 Run 继承父 gate 语义由既有 allowedTools 收窄兜底——子 Run 白名单本就无写/shell，trusted 不放大子 Run 能力）。
- 队列：enqueue/update 透传 trusted（QueuedItem.params 即 ChatCommand 子集，自动携带）；pumpQueue 出队后按各自 trusted 执行。
- `handlers.ts`：`message.send` 已整体透传（`agent.send(p)`），无需改；zod 校验由 contracts schema 自动生效。
- Grant 流不变：ask 才产生 grant；trusted 模式下 6 个操作走 automatic 分支，不产生 grant，但 Rust 侧 `require_grant` 对 file.write/edit/delete/move/mkdir、shell.execute **要求非空 grant**——需要处理（见下）。

### Rust 侧 grant 要求的适配

Rust `require_grant` 当前拒绝空 grant。为避免"trusted 模式下写操作全部失败"，采用**Runtime 签发会话级凭据**方案而非放宽 Rust 校验：

- Runtime 在 trusted Run 中对 6 个操作调用前，签发 `buildSessionGrant`（复用现有 30 分钟有效期的稳定引用凭据，grantId 形如 `trusted:<toolName>`），照常传给 Rust。
- 好处：Rust 校验逻辑零改动；审计轨迹保持（tool_calls.approval_grant_id 有值）；不引入新凭据类型。

## 前端变更（apps/desktop/frontend）

> 实施修订：最初设计为 ChatView 内的独立勾选框（useTrustedSessions per-session
> Record）。按用户后续决定改为**权限下拉第三档**（与工作区读写/只读同一下拉），
> 其余语义不变。此处记录修订后形态。

- `hooks/usePermissionMode.ts`：取值扩展为 `workspace | read-only | trusted`；
  前两档照旧持久化 localStorage，trusted 不持久化（change 时移除存储键，
  刷新后回落 workspace）。导出类型 `PermissionModeValue`。
- `components/Composer.tsx`：权限下拉新增第三档 `<option value="trusted">完全允许</option>`，
  title 如实标注"Shell 不受工作区限制、重启后回落工作区读写"。
- `useSessionActions.sendMessage`：从 permissionMode 派生——`read-only` 档传
  `permissionMode: 'read-only'`；`trusted` 档传 `trusted: true`（permissionMode
  省略即 Runtime 默认 workspace）。
- 落地页与聊天页共用同一下拉值（与既有 permissionMode 全局偏好行为一致）。
- `QueueBar.tsx`：排队项按发送时快照显示"信任放行"徽标（entry.trusted），
  提示该条出队后写/Shell 会自动放行（即使此刻已切回其它档）。

## 事件与 UI 呈现

- 不新增事件类型。信任模式下写/Shell 调用走既有 `tool.requested` → `tool.completed` 轨迹（无 approval.required），审批卡自然不出现。
- Run 行内不额外显示"信任"徽标（保持最小改动；工具轨迹已可见全部写入行为）。

## 错误处理

- `trusted: true` 但会话无工作区（独立会话）：gate 仍全 denied（现有 hasWorkspace 逻辑），模型收到 permission_denied，用户会看到失败原因。
- `trusted: true` 且 `permissionMode: 'read-only'`：read-only 优先，trusted 无效果（决策：不报错，静默以 read-only 为准；下拉单选下正常路径不会同时传，仅防御性语义）。
- 前端 localStorage 兼容：老值 `workspace`/`read-only` 原样解析；trusted 不写 localStorage（change 时移除键），刷新后回落 workspace。

## 测试

- Runtime 单测（apps/runtime/test/）：
  - permissions：trusted gate 对 6 个操作返回 automatic；read-only + trusted 仍 denied；无 workspace + trusted 仍 denied；MCP 名仍 ask。
  - runner 或 agent 级：trusted send 下 file.write 不发 approval.required 且成功执行（带 trusted grant）。
- 前端 typecheck/lint/build 覆盖 UI 链路。

## 文档

- `docs/PERMISSION-MODEL.md`：新增"会话信任开关"小节，如实标注 shell 无工作区边界、不持久化、重启失效；同步修订"不提供 full-access"表述（Phase 1 仍无全局 full-access Profile，但提供会话级信任开关）。

## 明确不做（YAGNI）

- 不做按项目持久化信任、不做 MCP 信任、不做审批卡批量授权、不做 Run 行信任徽标。

## 与最初设计的差异记录

- UI 形态：独立勾选框 → 权限下拉第三档"完全允许"（用户决定，交互更集中）。
- 生命周期随之调整：per-session 内存 Record → 全局下拉值（trusted 档仍不持久化，
  刷新回落 workspace；切换会话不再各自记忆——同一时刻全局只有一个档位生效，
  与既有 permissionMode 的全局语义保持一致）。
