# Agent Model

> Phase 1 schema-only：Phase 1A 只实现一个 Primary Agent，不注册 Worker/Research/Coding/Review/Planner，不产生子 Agent。

Agent 是可配置的执行主体，不是单独的一段 Prompt。`AgentDefinition` 由模型、工具、Skills、Memory Policy、Permission Policy 和 Delegation Policy 组成。

```text
AgentDefinition
├── model
├── tools
├── skills
├── memoryPolicy
├── permissionPolicy
└── delegationPolicy
```

Primary Agent 直接服务用户；Worker、Research、Coding、Review 和 Planner Agent 通过相同 Runtime 执行，只是定义不同。Agent Runtime 管理生命周期、上下文、工具调用和结果，不由 Provider 或 UI 管理。

第一阶段只实现一个 Primary Agent，但数据模型必须包含 `agentId`、`parentRunId`、`delegationId` 等字段，避免以后重做持久化协议。
