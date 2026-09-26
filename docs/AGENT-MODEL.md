# Agent Model

Agent 是 Runtime 管理的执行主体，不由 Provider 或 UI 管理。`AgentDefinition` 当前保存身份、说明、system prompt 与启停状态；模型、工具、记忆、权限和委派能力由 Run 启动边界解析，避免 manifest 声明越权。

```text
Primary Agent
  └── task → Worker | Researcher | Reviewer
                 └── isolated read-only Run (no task)
```

Phase 3A 注册 `worker`、`researcher`、`reviewer` 三个内置定义。Primary prompt 的可用子 Agent 清单从 Registry 动态投影，不硬编码内置 ID，禁用定义不会进入清单。子 Agent 继承父 Run 本次实际选择的 Provider、模型和采样参数，但不继承父上下文、长期记忆、审批或高权限工具。`agentId`、`parentRunId` 与 `delegationId` 持久化在 Run 中；Delegation 保存父子身份、生命周期与版本化执行快照。内置定义的官方元数据可随版本升级，但用户的启停状态不会被重启覆盖。

AgentDefinition 的工具/Skills/Memory Policy/Permission Policy/Delegation Policy 完整可配置化属于后续阶段；在隔离模型完成前，不允许定义自行扩大 Phase 3A 的固定只读边界。
