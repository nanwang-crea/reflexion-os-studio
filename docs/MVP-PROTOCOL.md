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

MVP command：`runtime.get_status`、`project.list`、`project.create`、`session.list`、`session.create`、`session.get`、`message.send`、`run.cancel`、`run.retry`、`provider.list`、`provider.configure`。

每个请求含 JSON-RPC `id` 和业务 `requestId`。未连接、超时和拒绝必须返回标准 error response。

## Events

事件 notification 使用：`runtime.status`、`session.created`、`message.created`、`message.delta`、`message.completed`、`run.started`、`run.completed`、`run.failed`、`run.cancelled`。

`message.delta` 包含 `messageId`、`chunkSeq` 和 `delta`；`message.completed` 包含完整内容、`finishReason` 和可选 usage。UI 按 messageId 累积并以 completed 对账。

## Provider Stream

Provider adapter 将 OpenAI-compatible SSE 映射为统一的 `delta`、`finishReason`、`usage` 和 typed error。MVP 不支持 Tool Call 增量。AbortSignal 从 UI 经 Host 传到 Runtime 和 Provider。
