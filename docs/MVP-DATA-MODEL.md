# MVP Data Model

## Canonical tables

MVP 采用 SQLite 单 Runtime 写入，不实现 outbox；实现使用 Node 内置 `node:sqlite`（无原生依赖）。数据目录为 `REFLEXION_DATA_DIR` 环境变量或 `~/.reflexion-os-studio`。核心表：

- `projects(id, name, created_at, updated_at)`
- `sessions(id, project_id, title, status, created_at, updated_at)`
- `messages(id, session_id, run_id, role, content, status, created_at, completed_at)`
- `runs(id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id)`
- `provider_profiles(id, name, base_url, model, secret_ref, enabled, updated_at)`

所有 ID 使用稳定字符串；外键约束开启；Session 删除策略明确为级联其消息和 Run，Provider secret 只保存引用。

## 状态

Run：`created → running → completed|failed|cancelled|interrupted`。Message：`pending → streaming → completed|interrupted|failed`。终态不可逆。Retry 创建新 Run 并保留原 Run。

## 流式与恢复

delta 只在传输层发送，不按 token 写库。Runtime 在开始时创建 User Message、Assistant Message 和 Run；完成时同一事务写入完整 Assistant Message、Run completed；异常时同一事务写入已累积内容和 interrupted/failed 状态。重启以 canonical tables 为准，不能重复提交已完成的消息。

## 后续扩展

Phase 1A-2 再增加 `tool_calls`、`approvals` 和审计事件；Phase 1B 增加 Workspace/Asset/Resource 索引；outbox 仅在确实需要跨进程可靠投递时引入。
