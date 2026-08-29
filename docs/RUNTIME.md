# Runtime 生命周期

核心对象：Session（会话）、Run（一次执行）、Turn（一次用户回合）、NodeRun（后续 Workflow 执行）、Checkpoint（后续可恢复快照）。

MVP Run 状态：`created → running → completed|failed|cancelled|interrupted`。MVP 不实现 waiting_approval、NodeRun 或 checkpoint 恢复；应用重启时以 SQLite canonical state 为准，将未完成 Run 标记为 interrupted。取消使用协作式 AbortSignal；Retry 创建新 Run 并保留原失败记录。

1A-2 再增加 waiting_approval、ToolCall 和 Rust 子进程恢复；Workflow 阶段再增加 NodeRun、暂停和 checkpoint。
