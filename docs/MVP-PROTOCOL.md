# MVP Protocol

## Transport

Tauri Host ↔ TypeScript Runtime 使用 JSON-RPC 2.0 over newline-delimited JSON。stdout 只允许协议消息，stderr 只写日志。Rust Bootstrap 同样使用该格式；MVP 阶段 Rust 只发送 ready、响应 ping 和 shutdown。

## Handshake

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.ready",
  "params": {
    "protocolVersion": "1.2",
    "runtimeVersion": "0.1.0",
    "capabilities": ["chat"]
  }
}
```

Runtime ready 是 Chat 可用条件。`system.ready` 只决定工具能力状态，不阻塞 Chat。版本不兼容进入 degraded/error，并显示可恢复提示。

## Commands

MVP command：`runtime.get_status`、`system.ping`、`project.list`、`project.create`、`project.delete`、`session.list`、`session.create`、`session.get`、`message.send`、`message.edit_resend`、`run.cancel`、`run.retry`、`approval.resolve`、`provider.list`、`provider.configure`、`provider.delete`、`provider.test`。

每个请求含 JSON-RPC `id` 和业务 `requestId`。未连接、超时和拒绝必须返回标准 error response。`session.get` 返回 `{ session, messages, runs, toolCalls }`，`toolCalls` 为会话内全部工具调用（跨 Run 汇总），供 UI 呈现工具轨迹。`message.send` 可选携带 `permissionPreset`（`workspace-read` | `workspace-write` | `workspace-full`，缺省 workspace-read）作为本次 Run 的权限预设快照（协议 1.2；一版本内兼容读取 legacy `permissionMode/trusted` 并映射）。`approval.resolve` 携带 `{ toolCallId, choiceId }`——choiceId 必须属于当前 pending approval（Runtime 下发 choices，服务端保存真实 effect），重复 resolve 或未知 choice 返回 `accepted=false`。

## Agent Loop

Run 内执行任务循环（`packages/agent-core`）：模型调用 → tool_calls → 权限闸门 → 工具执行 → 结果回填 → 下一轮，直到模型不再请求工具（Run completed）或达到轮次上限（Run failed，errorCode `max_turns`）。每个模型轮次落一条 assistant 消息；工具调用落 tool_calls 表并发出 `tool.requested` / `tool.completed`。闸门策略（权限模型 V2，详见 `docs/PERMISSION-MODEL.md`）：三档预设矩阵决定 automatic/ask；独立会话 file.* 一律 denied、Shell 仅显式提权进入审批；会话规则（workspace-path 精确路径 / shell-prefix token 前缀）与 ask-everything 覆盖项、Danger 租约都只存 Runtime 内存。ask 调用等待期间 Run 置 `awaiting_approval`（会话忙碌），发出 `approval.required`（携带 `subject/risk/context/choices`），由 `approval.resolve`（choiceId）落子；拒绝以 isError 结果回传模型（code `permission_denied`），不打断 Run。取消走 AbortSignal：中断当前流式轮次为 interrupted、进行中的工具调用为 cancelled、Run 为 cancelled。会话历史重建时，工具方言（assistant.tool_calls + role=tool）由 canonical tool_calls 表投影；上下文超预算时先做一次摘要压缩，压缩失败退化为截断。

## System Tools Protocol（TS ↔ Rust）

TS Runtime 经自有 stdio 通道调用 Rust System Runtime（方案 A，spawn/监管归属 TS）。方法：`system.ping`、`system.shutdown`、`file.read`、`file.list`、`file.write`、`shell.execute`；`system.cancel`（通知，无 id）按 requestId 树杀运行中的 shell。Rust 为 deny-by-default 硬边界：workspace-relative 路径规范化（拒绝绝对路径/`..`/符号链接逃逸）、读写体量上限（读 512KB / 写 2MB / 列表 2000 项）、shell 默认 30s 超时（上限 120s）、输出各 256KB 截断、超时按进程组/树杀回收、`file.write`/`shell.execute` 校验 grant 引用存在。workspaceRoot 由 TS 从项目 folderPath 传入（不来自模型）。shell.execute 异步回包，保证 cancel 可送达。

## Events

协议 1.2：每条事件信封含 `protocolVersion`、`eventId`、`scope`、`seq`、`occurredAt`、`type`。`scope` 是显式资源作用域（`runtime | run | session | project | mcp | terminal`），每个事件按作用域成对携带资源字段（run 通道 → `runId`；`queue.changed` → `sessionId`；`workspace.index.*` → `projectId`；`mcp.changed` → `serverId`；terminal 事件契约已在 W0 冻结、接线在 W2，携带 `projectId + terminalId`），`seq` 在单个发射器所代表的资源流内单调递增。信封与逐类事件的权威定义见 `packages/contracts/src/events.ts` 与 `docs/EVENT-PROTOCOL.md`。

事件 notification 使用：`runtime.status`、`session.updated`、`message.created`、`message.delta`、`message.reasoning_delta`、`message.reset`、`message.completed`、`run.started`、`run.completed`、`run.retrying`、`run.failed`、`run.cancelled`、`plan.created`、`plan.step.updated`、`plan.updated`、`queue.changed`、`workspace.index.progress`/`workspace.index.completed`/`workspace.index.failed`、`mcp.changed`、`delegation.created`/`delegation.updated`、`terminal.output`/`terminal.state`（集成终端输出帧与状态机事件，携带 `projectId + terminalId`），以及 Agent 工具链路事件：`tool.requested`、`tool.completed`、`approval.required`、`approval.resolved`（其授权范围字段名为 `grantScope`（`once | session`），避免与信封 `scope` 同键遮蔽；`approval.required` 可携带 `sessionId` 供侧栏显示待审批标记；V2 新增可选 `subject/risk/context/choices` 与 `approval.resolved.choiceId`，历史事件缺省仍可回放）、`danger.changed`（session 作用域的 Danger 租约生命周期：签发/撤销/到期/降级）。

`message.delta` 包含 `messageId`、`chunkSeq` 和 `delta`；`message.completed` 包含完整内容、`finishReason`（含 `tool_calls`）和可选 usage。UI 按 messageId 累积并以 completed 对账。

## Provider Stream

Provider adapter 将 OpenAI-compatible SSE 映射为统一的 `delta`、`finishReason`、`usage`、`toolCalls` 和 typed error。canonical `ToolSpec`（name/description/parameters JSON Schema）由适配层投影为 OpenAI function tools；`tool_calls` 增量按 index 聚合，`arguments` 以原始 JSON 字符串返回、由调用方按工具 schema 校验。AbortSignal 从 UI 经 Host 传到 Runtime 和 Provider。

Message 的 canonical 内容块为 `parts`（`text | image`），OpenAI 方言由适配层投影；`content` 是 text 块的纯文本投影。
