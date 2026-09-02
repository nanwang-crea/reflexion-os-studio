# MVP Data Model

## Canonical tables

MVP 采用 SQLite 单 Runtime 写入，不实现 outbox；实现使用 Node 内置 `node:sqlite`（无原生依赖）。数据目录为 `REFLEXION_DATA_DIR` 环境变量或 `~/.reflexion-os-studio`。核心表：

- `projects(id, name, folder_path, created_at, updated_at)`
- `sessions(id, project_id, title, status, created_at, updated_at)`
- `messages(id, session_id, run_id, role, content, parts_json, reasoning, status, created_at, completed_at)`，`parts_json` 为 canonical 内容块数组（`text | image | resource_link`；image 以 `assetId` 引用 Asset，不内联数据，resource_link 只保存受控资源引用），`content` 保留 Provider 原始 Markdown，供复制、历史上下文和降级显示
- `runs(id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id, agent_id, parent_run_id, delegation_id)`，后三列为 Agent/委派链路预留，Primary Agent 时为 NULL
- `tool_calls(id, run_id, message_id, tool_name, args_json, result_json, status, error_code, approval_grant_id, created_at, completed_at)`，工具调用的 canonical 记录（消息块中不重复保存 tool_use/tool_result）
- `memories(id, scope, scope_id, kind, content, source_run_id, confidence, embedding, embedding_model, status, created_at, updated_at, expires_at)`，A2 记忆表（mem0 式管线）：`scope` 为 `session|project|user`（user 的 `scope_id` 为 NULL，session/project 必填），`kind` 为 `fact|preference|procedure`，`embedding` 为 Float32 小端 BLOB（仅内部召回使用，不进协议），附带 FTS5 trigram 虚拟表 `memories_fts` 与同步触发器；`status` 为 `active|pinned|archived`（archived 为被取代的历史版本，管理页不展示）
- `provider_profiles(id, name, base_url, models, capabilities, secret_ref, enabled, updated_at)`，`models` 为 JSON 字符串数组：一个供应商可配多个模型，对话时按 `message.send` 的可选 `providerId`/`model` 指定，缺省回退到启用供应商的第一个模型；`capabilities` 为能力类型数组（`chat | embedding | image | video`），声明该 Provider 可参与的负载，编辑省略时保留原值、新建缺省 `["chat"]`；`provider.delete` 删除配置并清理对应密钥引用；`provider.test` 发起 1 token 补全做连接测试，错误原样返回 UI。
- 会话管理：`session.rename` 更新标题；`session.delete` 删除会话（消息与 Run 级联），有进行中 Run 时拒绝；`project.delete` 删除项目并级联其下会话。

所有 ID 使用稳定字符串；外键约束开启；Session 删除策略明确为级联其消息和 Run，Provider secret 只保存引用。

## 项目与两类会话

- 项目必须绑定一个本地文件夹：`projects.folder_path` 存放宿主文件夹选择器返回的绝对路径（由 `tauri-plugin-dialog` 提供，三平台各自原生对话框），同一 `folder_path` 不允许重复建项；项目名默认取文件夹 basename。
- 会话分两类：`sessions.project_id` 非空 → 项目内会话；为 NULL → 独立会话（不关联任何项目）。`session.list`/`session.create` 以 `projectId` 省略/`null`/具体 id 三种取值区分"全部/独立/指定项目"。
- 新会话标题默认为"新对话"；首条用户消息发送时由 Agent 派生标题（截断至 24 字符），会话 `updated_at` 随活动刷新以支持"最近会话"排序。
- Schema 变更通过 `PRAGMA user_version` 迁移（v1：重建 `sessions`/`projects` 使 `project_id` 可空并补 `folder_path`；v2：`provider_profiles` 单 `model` 列改为 `models` JSON 数组；v3：`messages` 补 `reasoning`；v4：`messages` 补 `parts_json` 并把既有 `content` 一次性回填为单 text 块，`runs` 补 agent 委派三列，`provider_profiles` 补 `capabilities`，新增 `tool_calls` 表；v5：新增 `memories` 表 + FTS5 索引，全新表无回填），旧数据保留，历史项目 `folder_path` 为空字符串。

## 状态

Run：`created → running → (awaiting_approval ↔ running) → completed|failed|cancelled|interrupted`，`awaiting_approval` 表示 Run 暂停等待工具审批，同属进行中（会话忙碌）；启动恢复时与 `created/running` 一样落为 `interrupted`，不自动放行。Message：`pending → streaming → completed|interrupted|failed`。ToolCall：`pending → awaiting_approval → running → completed|failed|cancelled`，启动恢复时未完结调用一律 `cancelled`。终态不可逆。Retry 创建新 Run 并保留原 Run。

## 流式与恢复

delta 只在传输层发送，不按 token 写库。Runtime 在开始时创建 User Message、Assistant Message 和 Run；完成时同一事务写入完整 Assistant Message、Run completed；异常时同一事务写入已累积内容和 interrupted/failed 状态。重启以 canonical tables 为准，不能重复提交已完成的消息。

## 后续扩展

Phase 1A-2 再增加 `tool_calls`、`approvals` 和审计事件；Phase 1B 增加 Workspace/Asset/Resource 索引；outbox 仅在确实需要跨进程可靠投递时引入。
