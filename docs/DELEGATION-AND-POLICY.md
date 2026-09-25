# Delegation and Policy

委派策略决定是否创建子 Run，权限策略决定它能使用什么能力；两者分别判断，并在启动时取更严格的边界。

```text
Delegation Policy                 Permission Policy
├── enabled                       ├── fixed tool allowlist
├── max depth / children          ├── workspace-read preset
├── parallel / timeout / tokens   ├── no inherited approvals
└── enabled AgentDefinition       └── no Danger or write capability
```

Phase 3A 只允许 Primary 委派一层只读子 Run。默认深度 1、总数 4、并行 2、超时 120 秒、token 12000；子 Run 无 `task`，不能继续委派。权限固定收窄为 `workspace-read`，父会话的审批、规则、Danger 租约和长期记忆均不继承。

父取消向所有活动子 Run 传播。子任务完成、失败、取消与启动恢复均须同步收敛 Run 和 Delegation 状态，并产生可观测事件。外部命令不能创建或修改 Delegation；只有 Runtime 内部 `task` 链路拥有写权。
