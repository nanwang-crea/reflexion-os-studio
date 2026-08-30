# MVP Protocol

## Transport

Tauri Host ↔ TypeScript Runtime 使用 JSON-RPC 2.0 over newline-delimited JSON。stdout 只允许协议消息，stderr 只写日志。Rust Bootstrap 同样使用该格式；MVP 阶段 Rust 只发送 ready、响应 ping 和 shutdown。

## Handshake

```json
{
  "jsonrpc": "2.0",
  "method": "runtime.ready",
  "params": {
    "protocolVersion": "1.0",
    "runtimeVersion": "0.1.0",
    "capabilities": ["chat"]
  }
}
```

Runtime ready 是 Chat 可用条件。`system.ready` 只决定工具能力状态，不阻塞 Chat。版本不兼容进入 degraded/error，并显示可恢复提示。

## Commands

MVP command：`runtime.get_status`、`system.ping`、`project.list`、`project.create`、`project.delete`、`session.list`、`session.create`、`session.get`、`message.send`、`run.cancel`、`run.retry`、`approval.resolve`、`provider.list`、`provider.configure`、`provider.delete`、`provider.test`。

每个请求含 JSON-RPC `id` 和业务 `requestId`。未连接、超时和拒绝必须返回标准 error response。`session.get` 返回 `{ session, messages, runs, toolCalls }`，`toolCalls` 为会话内全部工具调用（跨 Run 汇总），供 UI 呈现工具轨迹。`message.send` 可选携带 `permissionMode`（`workspace` | `read-only`，缺省 workspace）决定本次 Run 的工具权限 Profile；`approval.resolve` 携带 `{ toolCallId, decision: approved|denied, scope: once|session }`，重复 resolve 同一调用返回 `accepted=false`。

## Agent Loop

Run 内执行任务循环（`packages/agent-core`）：模型调用 → tool_calls → 权限闸门 → 工具执行 → 结果回填 → 下一轮，直到模型不再请求工具（Run completed）或达到轮次上限（Run failed，errorCode `max_turns`）。每个模型轮次落一条 assistant 消息；工具调用落 tool_calls 表并发出 `tool.requested` / `tool.completed`。闸门策略：`file.read`/`file.list` automatic；`file.write`/`shell.execute` 在 workspace Profile 下 ask、read-only Profile 下 denied；独立会话（无工作区）一律 denied。ask 调用等待期间 Run 置 `awaiting_approval`（会话忙碌），发出 `approval.required`，由 `approval.resolve` 落子（会话级授权存内存，进程重启失效）；拒绝以 isError 结果回传模型（code `permission_denied`），不打断 Run。取消走 AbortSignal：中断当前流式轮次为 interrupted、进行中的工具调用为 cancelled、Run 为 cancelled。会话历史重建时，工具方言（assistant.tool_calls + role=tool）由 canonical tool_calls 表投影；上下文超预算时先做一次摘要压缩，压缩失败退化为截断。

## System Tools Protocol（TS ↔ Rust）

TS Runtime 经自有 stdio 通道调用 Rust System Runtime（方案 A，spawn/监管归属 TS）。方法：`system.ping`、`system.shutdown`、`file.read`、`file.list`、`file.write`、`shell.execute`；`system.cancel`（通知，无 id）按 requestId 树杀运行中的 shell。Rust 为 deny-by-default 硬边界：workspace-relative 路径规范化（拒绝绝对路径/`..`/符号链接逃逸）、读写体量上限（读 512KB / 写 2MB / 列表 2000 项）、shell 默认 30s 超时（上限 120s）、输出各 256KB 截断、超时按进程组/树杀回收、`file.write`/`shell.execute` 校验 grant 引用存在。workspaceRoot 由 TS 从项目 folderPath 传入（不来自模型）。shell.execute 异步回包，保证 cancel 可送达。

## Events

事件 notification 使用：`runtime.status`、`session.created`、`message.created`、`message.delta`、`message.completed`、`run.started`、`run.completed`、`run.failed`、`run.cancelled`，以及 Agent 工具链路事件（工具循环已启用，审批事件待 Rust 工具接入）：`tool.requested`、`tool.completed`、`approval.required`、`approval.resolved`。

`message.delta` 包含 `messageId`、`chunkSeq` 和 `delta`；`message.completed` 包含完整内容、`finishReason`（含 `tool_calls`）和可选 usage。UI 按 messageId 累积并以 completed 对账。

## Provider Stream

Provider adapter 将 OpenAI-compatible SSE 映射为统一的 `delta`、`finishReason`、`usage`、`toolCalls` 和 typed error。canonical `ToolSpec`（name/description/parameters JSON Schema）由适配层投影为 OpenAI function tools；`tool_calls` 增量按 index 聚合，`arguments` 以原始 JSON 字符串返回、由调用方按工具 schema 校验。AbortSignal 从 UI 经 Host 传到 Runtime 和 Provider。

Message 的 canonical 内容块为 `parts`（`text | image`），OpenAI 方言由适配层投影；`content` 是 text 块的纯文本投影。
