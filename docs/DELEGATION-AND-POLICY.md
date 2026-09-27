# Delegation and Policy

委派策略决定是否创建子 Run，Agent Policy 决定它能使用什么能力；启动时取 Agent Policy、平台安全白名单与运行时设置的交集。

Phase 3 仍只开放只读子 Run，但已支持受控递归。`maxDepth` 的契约与运行时硬上限均为 4；默认深度 1。总数 4 和并行 2 是顶层 Run 整棵委派树共享的根级预算，不会在每个父节点重新获得额度。单项默认超时 120 秒、token 12000。

每个 `AgentDefinition` 持久化版本化 `AgentPolicy`：权限上限、工具允许集和能否继续委派。当前无论声明如何都不能突破 `workspace-read`。执行快照保存当时的 Policy 与根级预算，后续定义变化不改写历史。

父取消向活动子 Run 传播。子任务完成后从 canonical `ToolOutput` 聚合摘要、ResourceLink、Changed Files、usage 与工具调用数，并通过 `task` 回填模型；UI 通过一次根查询构建完整跨层树并可打开任意子 Session。外部命令不能创建或修改 Delegation；只有 Runtime 内部 `task` 链路拥有写权。
