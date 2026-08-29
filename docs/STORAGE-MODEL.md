# Storage Model

SQLite 存储 definition、runtime、event、asset、resource 和 workspace 索引。sessions、runs、messages、tool_calls、approvals、assets 和 workspace metadata 是 canonical tables；`runtime_events` 是 append-only 审计日志、通知和重放输入，不是唯一事实源。MVP 固定采用 SQLite 单 Runtime 事务写入 canonical state 和必要审计事件，不实现 outbox relay。恢复以 canonical state 为准，事件只用于 UI 通知和诊断；完整事件补发和 outbox 在后续跨进程可靠投递阶段增加。

图片、视频、附件和 AI 生成文档存受控 Asset Store，数据库只存 AssetRef、hash、mime、大小、预览和生命周期。Artifact 可引用 Asset 或 WorkspaceFile，ResourceLink 保存项目文件、Asset 和外部 URL 的结构化打开信息；Workspace projection 保存异步索引快照、统计、索引更新时间和 Git 摘要。`message.delta` 不按 token 写库，最终内容以 completed 状态落盘；中断消息标记 interrupted。迁移使用版本化 migration，删除、导出和重放均需保留审计语义。
