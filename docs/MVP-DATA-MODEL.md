# MVP Data Model

## Canonical tables

MVP 采用 SQLite 单 Runtime 写入，不实现 outbox；实现使用 Node 内置 `node:sqlite`（无原生依赖）。数据目录为 `REFLEXION_DATA_DIR` 环境变量或 `~/.reflexion-os-studio`。核心表：

- `projects(id, name, folder_path, created_at, updated_at)`
- `sessions(id, project_id, title, status, created_at, updated_at)`
- `messages(id, session_id, run_id, role, content, status, created_at, completed_at)`
- `runs(id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id)`
- `provider_profiles(id, name, base_url, models, secret_ref, enabled, updated_at)`，`models` 为 JSON 字符串数组：一个供应商可配多个模型，对话时按 `message.send` 的可选 `providerId`/`model` 指定，缺省回退到启用供应商的第一个模型；`provider.delete` 删除配置并清理对应密钥引用。

所有 ID 使用稳定字符串；外键约束开启；Session 删除策略明确为级联其消息和 Run，Provider secret 只保存引用。

## 项目与两类会话

- 项目必须绑定一个本地文件夹：`projects.folder_path` 存放宿主文件夹选择器返回的绝对路径（由 `tauri-plugin-dialog` 提供，三平台各自原生对话框），同一 `folder_path` 不允许重复建项；项目名默认取文件夹 basename。
- 会话分两类：`sessions.project_id` 非空 → 项目内会话；为 NULL → 独立会话（不关联任何项目）。`session.list`/`session.create` 以 `projectId` 省略/`null`/具体 id 三种取值区分"全部/独立/指定项目"。
- 新会话标题默认为"新对话"；首条用户消息发送时由 Agent 派生标题（截断至 24 字符），会话 `updated_at` 随活动刷新以支持"最近会话"排序。
- Schema 变更通过 `PRAGMA user_version` 迁移（v1：重建 `sessions`/`projects` 使 `project_id` 可空并补 `folder_path`；v2：`provider_profiles` 单 `model` 列改为 `models` JSON 数组），旧数据保留，历史项目 `folder_path` 为空字符串。

## 状态

Run：`created → running → completed|failed|cancelled|interrupted`。Message：`pending → streaming → completed|interrupted|failed`。终态不可逆。Retry 创建新 Run 并保留原 Run。

## 流式与恢复

delta 只在传输层发送，不按 token 写库。Runtime 在开始时创建 User Message、Assistant Message 和 Run；完成时同一事务写入完整 Assistant Message、Run completed；异常时同一事务写入已累积内容和 interrupted/failed 状态。重启以 canonical tables 为准，不能重复提交已完成的消息。

## 后续扩展

Phase 1A-2 再增加 `tool_calls`、`approvals` 和审计事件；Phase 1B 增加 Workspace/Asset/Resource 索引；outbox 仅在确实需要跨进程可靠投递时引入。
