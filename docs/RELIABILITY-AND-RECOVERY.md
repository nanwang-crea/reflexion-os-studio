# Reliability and Recovery

## M0 Bootstrap

只验证 sidecar 的 ready、status、ping、shutdown、协议解析和退出状态。Rust 未 ready 不阻塞 TypeScript Runtime 或纯 Chat；工具能力显示 unavailable。

## MVP Chat

Run：`created → running → completed|failed|cancelled|interrupted`。Approval、ToolCall、waiting_approval 和 checkpoint 在 1A-2 再加入。终态不可逆。

Provider chunk 带 `messageId` 和递增 `chunkSeq`；UI 按 messageId 累积 delta，Runtime 最终写入完整 Message，并保存 `finishReason`、usage 和 provider request id。MVP 不支持 Tool Call 增量。

MVP 取消从 Renderer → Tauri Host → TypeScript Runtime → Provider 传播，使用 requestId 关联。取消请求幂等；若完成和取消竞态，先提交 canonical 终态者生效。1A-2 再扩展到 Rust Tool 子进程。

MVP 应用重启后以 SQLite canonical state 为准，将未完成 Run 标记为 interrupted。未完成模型回复保留 partial 内容，不假装完整。Retry 创建新的 Run，并关联 `retryOfRunId`；MVP 不自动重试有副作用的操作。
