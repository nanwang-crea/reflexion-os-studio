# Agent Model

Agent 是 Runtime 管理的执行主体，不由 Provider 或 UI 管理。`AgentDefinition` 保存身份、说明、system prompt、启停状态与版本化 Agent Policy；策略声明只能收窄能力，不能越权。

```text
Primary Agent
  └── task → Worker | Researcher | Reviewer
                 └── isolated read-only Run
                       └── task（Policy 允许且深度 < 4）
```

Runtime 每次委派都创建唯一 Agent 实例。`worker`、`researcher`、`reviewer` 是可选内置模板，不是预创建的运行角色；用户模板与内置模板使用同一读取模型。Primary 可选择模板，也可无模板动态给出名称、职责和指令。子 Agent 继承父 Run 本次实际选择的 Provider、模型、采样参数、权限档位与工具交集，但不继承父上下文、长期记忆、Danger 或一次性批准；仅在 `maxDepth` 内继续获得 `task`。动态实例快照、`agentId`、`parentRunId` 与 `delegationId` 均持久化，Delegation 保存父子身份、生命周期与版本化执行边界。

Agent Policy 当前覆盖权限上限、工具允许集与委派能力，并持久化到执行快照。Skills/Memory Policy 与可写权限仍属后续阶段；任何定义都不能扩大固定只读边界。
