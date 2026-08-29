# Delegation and Policy

Phase 1A 禁止创建子 Agent；本文件中的 Delegation 仅作为未来协议设计。委派策略决定 Agent 是否、何时以及以什么边界创建子 Agent；权限策略决定工具和节点是否需要审批。二者分离但共同约束一次 Delegation。Phase 1 的 Permission Policy 只使用 Profile 与 `automatic/ask/denied` 决策，不使用 capability token；ApprovalGrant 是 Runtime 内部的短期引用。

```text
Delegation Policy
  ├── allowed agent types
  ├── max depth / max children
  ├── time and token budget
  └── result format

Permission Policy
  ├── allowed tools
  ├── allowed paths/commands
  ├── approval mode
  └── inheritance rule
```

子 Agent 的权限取父级策略与自身声明的交集，不可扩大权限。审批不会因为委派自动继承；高风险子任务仍须经过 Approval Gateway。Coordinator 只聚合结构化结果，不修改原始事件。Policy Decision、Delegation Created、Approval Required/Resolved 和 Delegation Completed 都必须进入事件日志。
