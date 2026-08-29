# Multi-Agent Orchestration

Phase 1A 只保留多 Agent 字段和契约，禁止 Delegation、并行、层级协作和结果聚合；完整实现从 Phase 3 开始。

多 Agent 是 Runtime 的受控委派能力，不是让 Agent 无限递归创建子 Agent。支持顺序、并行和层级委派：Primary Agent 可以将独立任务交给 Worker/Research/Coding/Review Agent，再由 Coordinator 聚合结构化结果。

每次委派必须记录 `delegationId`、`parentRunId`、`childRunId`、`parentAgentId`、`childAgentId`、工具白名单、权限策略、上下文预算、时间限制、最大深度和最大子任务数。子 Agent 默认使用独立 Context，只接收任务所需的信息和显式输入。

子 Agent 不得默认继承父 Agent 的全部工具、权限或长期记忆，不得绕过审批，也不得直接写入用户级长期记忆。取消父 Run 时按策略取消子 Run；子任务失败可按策略重试、降级或交给人工处理。所有委派和结果都产生事件。

Phase 1 只保留契约和 Primary Agent；Phase 3 才实现完整并行、层级、预算、聚合和 UI 展示。
