# Multi-Agent Orchestration

## Phase 3：动态受控委派

Primary Agent 已可动态创建子 Agent；在显式深度预算内，子 Agent 也可继续委派。它不是预定义角色队列，也不是 Workflow。

Primary 通过 `task` 工具提交任务和可选的 `templateId/name/role/instructions`。每次调用生成独立 Agent 实例；模板仅提供可选提示与收窄策略，不再代表预创建 Worker。多个互不依赖的 `task` 调用可在同一模型轮并行。结果以版本化结构回填摘要、资源链接、变更文件、usage 和工具调用数。

子实例继承父 Run 的 Provider、模型、权限档位和可见工具交集；模板只能收窄，Runtime 再移除管理与机密能力。Danger、一次授权和审批覆盖项不继承。用户可在 Composer 显式选择本次根 Run 的默认模板，该选择优先于模型建议并随 Run 持久化。一个根树共享可复用资源规则和 mutation coordinator，每次成功变更记录归属 receipt。

### 固定执行边界

- 子 Run 继承父 Run 的 Provider 与模型，但使用独立 Session、独立上下文和 Agent system prompt；只注入委派任务，不注入父历史、AGENTS.md、MEMORY.md 或 checkpoint。
- 子 Run 的有效权限和工具集是父 Run、模板限制及 Runtime 硬拒绝策略的交集。可写父 Run 可以委派可写实例，但模板不能扩大父边界；只有 Policy 允许且低于 `maxDepth` 才开放 `task`，管理、机密、长期记忆等能力始终排除。
- 父会话可复用的精确路径/命令规则在根权限域内共享；一次授权、待处理审批、审批覆盖项和 Danger 租约不继承。每次需要审批的调用仍独立经过 PermissionGate，卡片展示动态 Agent、层级和根任务。
- 根级 mutation coordinator 串行执行兄弟写入，Rust 侧以 `mtime + size + sha256` revision 拒绝陈旧写。冲突返回 `file_revision_conflict`，Agent 必须重新读取并重新合并；不做静默自动合并。
- 默认限制：深度 1（硬上限 4）、整棵委派树最多 4 个子 Run、树级最多并行 2 个、单子 Run 120 秒、总 token 12000。根级协调器由所有后代共享，超过时返回稳定错误码。
- 内部子 Session 不出现在普通会话列表，但 Run、Message、ToolCall、Delegation 均持久化；父 Run 卡片可查看实时状态、执行快照、子 Session 轨迹与下级委派，并可取消活动子 Run。
- Delegation 保存 `rootRunId`、`parentAgentId`、`childSessionId`，并以版本化 `execution` 快照冻结实际深度、Provider/模型、Agent Policy、权限预设、工具白名单及预算；`delegation.tree` 一次返回完整树，UI 可选择任意节点查看子 Session 轨迹。

### 生命周期与恢复

每次委派记录 `delegationId`、父子 Run/Session/Agent 身份、执行快照、任务、状态、结果或错误。父 Run 取消会通过 AbortSignal 取消活动子 Run；子任务失败只使本次 `task` 工具调用失败，Primary 可据此调整或继续。启动恢复以 child Run 为 canonical 状态：遗留活动 Run 收敛为 interrupted/failed；若 Run 已完成或取消但 Delegation 终态回调漏写，则反向补齐 completed/cancelled，避免永久 running。

Delegation 写入只允许 Runtime 内部 `task` 链路；外部 `delegation.create/update/attach_child_run` 命令保持拒绝，避免伪造生命周期。创建和更新都会产生 delegation 事件。

## 回滚边界

Mutation receipt 是变更归属记录，不是完整撤销日志。删除、移动和整文件覆盖若未保存 preimage，无法承诺通用一键回滚；因此当前 UI 不提供会产生错误安全感的回滚按钮。未来若开放，应先增加有大小上限、敏感路径过滤和生命周期清理的 preimage store，并让恢复操作重新经过 PermissionGate。任何扩展都不能绕过 ToolRegistry、PermissionGate、Agent Policy 或根级预算边界。
