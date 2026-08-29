# Memory System

> Phase 1A 限定：只实现 Run-local Working Memory 和 Session Context。Project Memory 仅作为显式用户维护的只读/受限占位；不做自动提取、召回、Embedding、自动写入或 Long-term Memory。

Memory 分为四层：

- **Working Memory**：当前 Run 的目标、计划、工具摘要和子任务结果，Run 结束后归档或丢弃。
- **Session Memory**：当前会话确认的事实、约束和决策。
- **Project Memory**：项目技术栈、命令、规范、架构决策和常见问题。
- **Long-term Memory**：跨项目的稳定用户偏好，必须谨慎写入。

记忆生命周期为：提取 → 去重 → 评分 →（必要时）用户确认 → 写入 → 召回 → 衰减/删除。Memory 不是单一向量库；可以组合 SQLite、全文检索、Embedding 和结构化事实。

权限分为 `read`、`propose`、`write`、`delete`。Primary Agent 可读取工作和会话记忆；Project Memory 自动写入应先形成候选；Long-term Memory 原则上需要确认；Worker Agent 默认只读，不得直接写用户级记忆。每次写入保留来源、置信度、范围、创建时间和过期策略。

Phase 1 实现 Working/Session Context 和基础 Project Memory 接口；Phase 2 实现召回、提案和 Skill 关联；Long-term Memory 在安全策略成熟后启用。
