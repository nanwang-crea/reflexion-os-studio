# Agent Model

Agent 是 Runtime 管理的执行主体，不由 Provider 或 UI 管理。`AgentDefinition` 当前保存身份、说明、system prompt 与启停状态；模型、工具、记忆、权限和委派能力由 Run 启动边界解析，避免 manifest 声明越权。

```text
Primary Agent
  └── task → Worker | Researcher | Reviewer
                 └── isolated read-only Run (no task)
```

Phase 3A 注册 `worker`、`researcher`、`reviewer` 三个内置定义。它们继承父 Run 的 Provider/模型，但不继承父上下文、长期记忆、审批或高权限工具。`agentId`、`parentRunId` 与 `delegationId` 持久化在 Run 中，Delegation 保存父子生命周期。

AgentDefinition 的工具/Skills/Memory Policy/Permission Policy/Delegation Policy 完整可配置化属于后续阶段；在隔离模型完成前，不允许定义自行扩大 Phase 3A 的固定只读边界。
