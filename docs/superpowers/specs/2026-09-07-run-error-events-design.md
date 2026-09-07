# Run 错误与重试事件持久化设计

## 目标

将 Agent Run 的每次 Provider 重试和最终失败转为可持久化、可恢复的会话时间线事件。用户在运行期间能看到全局错误提示与 Run 进度，重启应用后仍能在原会话中看到每次重试原因、次数以及最终错误码和完整错误信息。

## 方案

新增 `run_events` 存储域，而不是把运行事件伪装成普通 Message。每条事件关联 session、run，保存事件类型、重试次数、最大重试次数、原因、错误码、错误信息和创建时间。Runtime session snapshot 同时返回 `runEvents`；前端按 runId 将事件卡插入对应 RunBlock 前后，保持消息时间线的独立视觉语义。

Retrying 事件在 runner 即将再次调用 Provider 时写入数据库并发送事件；failed 事件在 Run 终态事务成功后写入数据库并发送事件。持久化失败不能吞掉原有运行错误，须沿现有 Runtime 错误处理路径记录并继续发出失败事件。

## 数据流

1. `runner.ts` 收到可重试 Provider 错误，创建 run event：`retrying`，保存 `attempt/maxRetries/reason`，再发出现有 `run.retrying`。
2. Run 最终失败时保存 `failed`，保存 `error.code/error.message`，再发出现有 `run.failed`。
3. `session.get` 或现有 session bootstrap 返回 `runEvents`，契约由 `packages/contracts` 定义并校验。
4. `useAppBootstrap` 收到 retrying/failed 后继续更新实时 RunActivity，同时设置全局 alert notice；刷新 session 后获得持久化事件。
5. ChatView 将事件按 runId 映射到时间线，RunEventCard 独立显示每一条 retrying 和 failed；失败 RunBlock 标签改为“运行失败”，AssistantMessage 显示具体错误详情和重试入口。

## 交互与显示

- 重试卡显示：`正在重试（第 attempt/maxRetries 次）` 与该次 `reason`。
- 失败卡显示：错误码与完整错误信息；不把失败 Run 显示为“处理完成”。
- 当前运行中的 retrying 事件同时显示在 RunBlock 的活动状态中。
- `run.failed` 即时触发全局 `role=alert` notice，消息包含错误码和错误详情。
- 历史事件不依赖当前内存态；应用重启、重新进入 session 后仍显示。
- 不修改普通 Message 的状态语义；取消和完成不新增事件，避免扩大范围。

## 存储与迁移

新增 `run_events` 表及 session/run 索引，使用 schema migration 版本推进。字段为：`id`、`session_id`、`run_id`、`type`、`attempt`、`max_retries`、`reason`、`error_code`、`error_message`、`created_at`。不记录 secret；Provider 原始响应只保留经过现有错误规范化后的安全 message。

Runtime store 新增独立 `runEvents.ts` 领域类，`store/index.ts` 仅负责连接、迁移和门面暴露。读取按 session 和 created_at 排序。

## 测试

- contracts：run event schema 与 session snapshot schema 验证 retrying/failed 两种形态。
- Runtime store：插入、查询、外键级联和迁移验证。
- runner：retrying/failed 均落库且事件字段正确。
- 前端：实时 run.failed notice、RunBlock 失败标签、AssistantMessage 详情、多个 retrying 卡片和重启 snapshot 恢复显示。
- 验证命令按 AGENTS.md 执行 format、lint、typecheck、构建及 Rust 检查。
