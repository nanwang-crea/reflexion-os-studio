# Memory System

> Phase 1A 限定：只实现 Run-local Working Memory 和 Session Context。Project Memory 仅作为显式用户维护的只读/受限占位；不做自动提取、召回、Embedding、自动写入或 Long-term Memory。
> 更新：A2 已按 `AGENT-PLATFORM-PLAN.md` §5 落地 mem0 式本地管线（提取/合并/召回/管理页），
> scope 语义、生命周期与权限边界以该节与本文为准；User 级 propose→confirm 流程待 A2 收尾。
> 更新（2026-09，Context Engine V2 / Agent Loop Hardening）：
>
> - **写入不再 fire-and-forget**：成功 Run 的终态事务幂等创建 `memory_jobs`，由单 worker 空闲消费（并发 1、前台 Run 可抢占、重启恢复、最多 3 次退避重试 5s/30s/5min）；失败/取消 Run 不入队。
> - **Transcript 脱敏**：提取输入只含 user/assistant 正文、工具名 + 短参数摘要（>80 字截断、疑似机密 `<redacted>`）、状态/errorCode 与结果短摘要；不含 reasoning、ApprovalGrant、密钥或完整大文件。
> - **复合召回**：查询文本 = 当前+最近 3 条用户消息 + Checkpoint goal/pending + 活动 Plan goal/进行中步骤（1200 字符上限）；embedding 查询 500ms deadline，超时立即 FTS+recency 降级。
> - 合并管线：无相似候选直接 ADD（不调 merger）；相似候选批量一次 merger；失败时无相似 ADD、有相似 NOOP。

Memory 分为四层：

- **Working Memory**：当前 Run 的目标、计划、工具摘要和子任务结果，Run 结束后归档或丢弃。
- **Session Memory**：当前会话确认的事实、约束和决策。
- **Project Memory**：项目技术栈、命令、规范、架构决策和常见问题。
- **Long-term Memory**：跨项目的稳定用户偏好，必须谨慎写入。

记忆生命周期为：提取 → 去重 → 评分 →（必要时）用户确认 → 写入 → 召回 → 衰减/删除。Memory 不是单一向量库；可以组合 SQLite、全文检索、Embedding 和结构化事实。

权限分为 `read`、`propose`、`write`、`delete`。Primary Agent 可读取工作和会话记忆；Project Memory 自动写入应先形成候选；Long-term Memory 原则上需要确认；Worker Agent 默认只读，不得直接写用户级记忆。每次写入保留来源、置信度、范围、创建时间和过期策略。

Phase 1 实现 Working/Session Context 和基础 Project Memory 接口；Phase 2 实现召回、提案和 Skill 关联；Long-term Memory 在安全策略成熟后启用。
