# Multi-Agent Orchestration

## Phase 3：受限只读委派

Primary Agent 已可向只读子 Agent 受控委派；在显式深度预算内，子 Agent 也可继续委派。它不是 Workflow，任何层级都不允许写入工作区。

Primary 通过 `task` 工具提交任务和可选的 `templateId/name/role/instructions`。每次调用生成独立 Agent 实例；模板仅提供可选提示与收窄策略，不再代表预创建 Worker。多个互不依赖的 `task` 调用可在同一模型轮并行。结果以版本化结构回填摘要、资源链接、变更文件、usage 和工具调用数。

子实例继承父 Run 的 Provider、模型、权限档位和可见工具交集；模板只能收窄，Runtime 再移除管理与机密能力。Danger、一次授权和审批覆盖项不继承。一个根树共享可复用资源规则和 mutation coordinator，每次成功变更记录归属 receipt。

### 固定执行边界

- 子 Run 继承父 Run 的 Provider 与模型，但使用独立 Session、独立上下文和 Agent system prompt；只注入委派任务，不注入父历史、AGENTS.md、MEMORY.md 或 checkpoint。
- 子 Run 固定使用 `workspace-read`。工具取平台只读安全集与 Agent Policy 的交集；只有 Policy 允许且低于 `maxDepth` 才开放 `task`，始终没有写文件、Shell、MCP、memory 或 plan。
- 父会话审批、会话规则和 Danger 租约不向子 Run 传播。子权限始终是父边界与固定只读边界的收窄结果，不可扩大。
- 默认限制：深度 1（硬上限 4）、整棵委派树最多 4 个子 Run、树级最多并行 2 个、单子 Run 120 秒、总 token 12000。根级协调器由所有后代共享，超过时返回稳定错误码。
- 内部子 Session 不出现在普通会话列表，但 Run、Message、ToolCall、Delegation 均持久化；父 Run 卡片可查看实时状态、执行快照、子 Session 轨迹与下级委派，并可取消活动子 Run。
- Delegation 保存 `rootRunId`、`parentAgentId`、`childSessionId`，并以版本化 `execution` 快照冻结实际深度、Provider/模型、Agent Policy、权限预设、工具白名单及预算；`delegation.tree` 一次返回完整树，UI 可选择任意节点查看子 Session 轨迹。

### 生命周期与恢复

每次委派记录 `delegationId`、父子 Run/Session/Agent 身份、执行快照、任务、状态、结果或错误。父 Run 取消会通过 AbortSignal 取消活动子 Run；子任务失败只使本次 `task` 工具调用失败，Primary 可据此调整或继续。启动恢复以 child Run 为 canonical 状态：遗留活动 Run 收敛为 interrupted/failed；若 Run 已完成或取消但 Delegation 终态回调漏写，则反向补齐 completed/cancelled，避免永久 running。

Delegation 写入只允许 Runtime 内部 `task` 链路；外部 `delegation.create/update/attach_child_run` 命令保持拒绝，避免伪造生命周期。创建和更新都会产生 delegation 事件。

## 后续阶段

后续再开放可写 Coding Agent 的细粒度权限交集与审批。任何扩展都不能绕过 ToolRegistry、PermissionGate、Agent Policy 或根级预算边界。
