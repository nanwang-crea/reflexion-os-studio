# Event Protocol

Command 是请求，Event 是最小审计和 UI 通知。MVP 采用 SQLite 单 Runtime 写入：canonical 状态和必要事件在同一事务提交，不实现 outbox relay 或完整事件溯源；后续出现跨进程可靠投递需求时再引入 outbox。

每条事件包含 `protocolVersion`、`eventId`、`scope`、`seq`、`occurredAt` 和 `type`。`scope` 是显式资源作用域（`runtime | run | session | project | mcp | terminal`），每个 `type` 在契约中与其资源字段成对声明（run → runId；queue → sessionId；workspace → projectId；mcp → serverId；terminal → projectId + terminalId），不再借用 runId。`seq` 在**单个发射器实例所代表的资源流**内单调递增（run 通道为每 Run 一个流；queue 为每会话一个流；workspace 索引为每轮扫描一个流）；跨流排序以 `occurredAt` + `eventId` 为准。MVP 的 UI 以快照 + 事件通知为准；完整重放（afterSeq）延后。事件可幂等消费。传输使用 JSON-RPC 2.0 over newline-delimited stdio：stdout 只传协议，stderr 只写日志；通知使用 JSON-RPC notification。`message.delta` 只在内存/传输层发送，最终 `message.completed` 和消息状态落盘，不按 token 写库；恢复以 canonical state 为准。`message.completed.parts` 可携带结构化内容块，其中 `resource_link` 只允许 `projectId + workspace-relative path`、Asset 引用或 HTTPS 外链；原始 Provider Markdown 仍保存在 `content`，前端优先使用 parts 渲染。
