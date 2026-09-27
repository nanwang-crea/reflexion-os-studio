# TurnExecution 状态机

`TurnExecution` 是 Run 内单次“模型请求 → 工具批次 → 结果聚合”的持久化执行检查点。
它不替代 `Run`、`Message` 或 `ToolCall`，而是统一记录这些实体当前处于哪一个可恢复阶段。

```text
processing_input
  → awaiting_model_response
  → streaming
  → scheduling_tools
  → awaiting_permission | executing_tools
  → awaiting_user_input | aggregating_results
  → completed | failed | cancelled | interrupted
```

Runtime 当前会持久化：

- `turnId`、`runId`、`phase`、`attempt`
- 模型请求的非机密元数据与 assistant message id
- 工具批次快照
- 待处理 interaction / approval id
- continuation reason 与 checkpoint version

## 恢复策略

`Store.recoverRuntimeState()` 是唯一启动恢复入口。它先调用 Turn reducer，再把决定投影到
Run、Message、ToolCall 与 Delegation 等兼容实体。

当前只有**顶层 Run** 的 `awaiting_user_input`，且对应 `user_interactions` 仍为
pending 时可安全恢复。委派 Run 的父 `task` 调用栈尚未持久化，重启后无法把子结果
可靠回填给父 Run；因此子 Agent 的等待输入会连同父子活动链显式收敛为
`interrupted/failed`，interaction 保留为 `cancelled` 审计记录，不再允许回答。
以下阶段会显式转为 `interrupted`：

- 模型请求或流式输出：Provider 请求没有可重连流标识；
- 等待审批：会话规则、精确 grant 与 Danger lease 不跨进程恢复；
- 工具调度或执行：工具尚无统一幂等键，自动重放可能重复副作用；
- 结果聚合：尚未保存足以证明批次完整提交的 checkpoint。
- 子 Agent 等待输入：缺少父 ToolCall 关联和整棵委派树 checkpoint，禁止只恢复子 Run。

后续若要开放自动续跑，必须先为对应阶段补齐幂等边界和可验证 checkpoint，再修改 reducer；
不能仅凭 phase 直接重放。
