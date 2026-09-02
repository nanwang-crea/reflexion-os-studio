# Event Protocol

Command 是请求，Event 是最小审计和 UI 通知。MVP 采用 SQLite 单 Runtime 写入：canonical 状态和必要事件在同一事务提交，不实现 outbox relay 或完整事件溯源；后续出现跨进程可靠投递需求时再引入 outbox。

每条持久化事件包含 `protocolVersion`、`eventId`、`runId`、`seq`、`occurredAt` 和 `type`。MVP 的 seq 在每个 run 内单调递增，UI 以 session 快照和事件通知为准；完整 afterSeq 重放延后。事件可幂等消费。传输使用 JSON-RPC 2.0 over newline-delimited stdio：stdout 只传协议，stderr 只写日志；通知使用 JSON-RPC notification。`message.delta` 只在内存/传输层发送，最终 `message.completed` 和消息状态落盘，不按 token 写库；恢复以 canonical state 为准。`message.completed.parts` 可携带结构化内容块，其中 `resource_link` 只允许 `projectId + workspace-relative path`、Asset 引用或 HTTPS 外链；原始 Provider Markdown 仍保存在 `content`，前端优先使用 parts 渲染。
