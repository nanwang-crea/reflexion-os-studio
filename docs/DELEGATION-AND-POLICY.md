# Delegation and Policy

委派策略决定是否创建子 Run，Agent Policy 决定它能使用什么能力；启动时取 Agent Policy、平台安全白名单与运行时设置的交集。

Phase 3 已开放动态可写子 Run，并支持受控递归。`maxDepth` 的契约与运行时硬上限均为 4；默认深度 1。总数 4 和并行 2 是顶层 Run 整棵委派树共享的根级预算，不会在每个父节点重新获得额度。单项默认超时 120 秒、token 12000。

每个动态实例保存版本化执行快照：权限上限、工具允许集和能否继续委派。实例继承父 Run 的实际边界，模板只能继续收窄，不能提权；后续模板变化不改写历史。Composer 可为本次根 Run 显式指定默认模板，其优先级高于模型在 `task` 参数中的选择。

父取消向活动子 Run 传播。子任务完成后从 canonical `ToolOutput` 聚合摘要、ResourceLink、Changed Files、usage 与工具调用数，并通过 `task` 回填模型；UI 通过一次根查询构建完整跨层树并可打开任意子 Session。审批卡显示发起审批的动态 Agent、递归层级和根任务，用户无需从子 Session 反推来源。外部命令不能创建或修改 Delegation；只有 Runtime 内部 `task` 链路拥有写权。

同一根树的写操作由 mutation coordinator 串行化，文件写入再由 Rust 侧用精确 revision 做最终 compare-and-swap。旧 revision 返回稳定的 `file_revision_conflict`，要求 Agent 重新读取并基于最新文本合并，禁止原样重试；Runtime 不做无语义保证的静默自动合并。变更 receipt 用于归属和审计，不等同于可逆快照。
