## 本轮目标
在现有协议/存储底座上完成一个可实际运行的 MVP 子 Agent：Primary Run 调用 `task` 工具后，Runtime 创建并执行 child Run，child Run 使用独立执行上下文，最终以结构化结果回填父工具调用；同时补齐取消、生命周期事件和基础查询能力。

本轮不实现：通用 Workflow/DAG、完整 Agent Registry 编辑器、复杂并行调度、用户级记忆写入、独立委派详情页。

## 实施步骤

### 1. 完善委派持久层与 contracts
- 扩展 `DelegationStore`：
  - `attachChildRun(delegationId, childRunId)`；
  - `update` 支持终态幂等；
  - 校验 parent Run/session/agent 引用；
  - 增加按 parent run、按 delegation 查询。
- 补齐 Delegation 的预算/错误/结构化结果字段，但保持旧数据库行兼容。
- 增加最小 `task` 工具参数/result schema，以及 `delegation.cancel` 或复用 `run.cancel` 的明确语义。
- 将 `delegation.created/updated` 事件接入真正的 Runtime emitter，确保事件只由委派服务发出一次。

### 2. 抽取内部 ChildRunStarter
新增 Runtime 内部窄接口，例如：
```ts
interface ChildRunStarter {
  start(input: {
    parentRun: Run
    agentId: string
    task: string
    signal: AbortSignal
  }): Promise<{ delegationId: string; childRunId: string; result: ChildResult }>
}
```

- 不让 `task` 工具依赖完整 `ChatAgent`。
- 在 `ChatAgent` 内实现 starter：校验目标 Agent、父 Run 关系、递归深度/子任务数、启用状态和基础预算。
- 创建 delegation、child Run、child user/assistant message，并原子关联 `childRunId`。
- 不调用 `startSend()`，绕过 session idle/queue 限制；child Run 复用现有 `launch`/`RunRunner` 装配，但使用独立 controller、emitter、registry、PermissionGate 和 ApprovalGateway 关联。

### 3. 让 RunRunner 返回结果
- 将 `RunRunner.execute()` 从 `Promise<void>` 扩展为返回 `{ status, text, errorCode?, usage? }`，保留现有调用方兼容。
- 从现有 assistant 草稿/最终 message 中提取文本；失败、取消、审批等待状态映射为稳定的 ChildResult。
- child Run 结束时更新 Run 与 Delegation，发布 `delegation.updated`，所有终态操作幂等。
- 父 controller abort 时级联 abort 正在运行的 child controllers；父失败/取消不留下孤儿 child。

### 4. 增加 task 工具与 scoped registry
- 在 `ToolContext` 注入窄化 `childRunStarter`（Primary Run 才注入）。
- 新增 `tools/task.ts`，参数至少包含 `agentId`、`task`，执行时：
  - 校验参数和目标 Agent；
  - 调用 starter；
  - 返回 `{ delegationId, childRunId, status, summary, error }`；
  - 子 Run 取消/审批等待不被伪装成成功。
- `createToolRegistry` 支持 `allowedTools`/`includeDelegation` capability profile；child registry 默认不注册 `task`，防止递归。
- Primary 默认仅允许内置安全 Agent；工具/权限按父 profile 与 child profile 的交集装配。

### 5. 取消与事件
- 扩展 `ChatAgent.cancel(runId)` 为级联取消 descendants；增加 parent→child controller 映射并在终态清理。
- child 审批使用 child runId/toolCallId，默认不继承父审批 grant。
- 复用现有事件 envelope，新增 delegation 关联 payload；保证父、子各自 seq 单调，UI 可按 `parentRunId/delegationId` 聚合。
- 重启恢复时，未完成 child Run 保持 interrupted，并将 delegation 置为 failed/retryable，不伪造成功。

### 6. Runtime-client 与基础前端展示
- 新增 typed API：`listAgents()`、`listDelegations(sessionId)`，组件不直接请求 transport。
- 在 Chat RunBlock 增加 delegation 状态/agent badge/可折叠 child 结果；历史加载通过 delegation 查询补充。
- 优先使用现有事件订阅刷新，不新增独立页面；设置页 Registry 编辑放到后续迭代。

### 7. 测试与验证
新增测试覆盖：
- task 参数错误、目标 Agent 不存在/禁用；
- child Run 创建、parent/child/delegation 关联和结构化结果；
- child registry 不含 task，权限不超过父级；
- 父取消级联 child；
- delegation 事件及终态幂等；
- 重启恢复与旧 `agentId = null` Run 兼容。

然后运行：
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm --filter @reflexion-os-studio/runtime test`
- `pnpm build:packages`
- 可行时运行 Rust fmt/test/check 与 desktop 构建，并如实报告环境限制。

## 预计修改模块
- `apps/runtime/src/agent/index.ts`
- `apps/runtime/src/agent/runner.ts`
- `apps/runtime/src/agent/tools/index.ts`
- `apps/runtime/src/agent/tools/shared.ts`
- 新增 `apps/runtime/src/agent/tools/task.ts`
- 新增/扩展 `apps/runtime/src/agent/delegation.ts`
- `apps/runtime/src/store/delegations.ts`、`runs.ts`、`index.ts`
- `packages/contracts/src/entities.ts`、`commands.ts`、`events.ts`
- `packages/runtime-client/src/*`
- `apps/desktop/frontend/features/chat/*` 与对应 API 文件

实现时会优先保证 Runtime 子 Run 可执行与可取消，再接入前端展示；如果现有 Runner/Context 耦合使完整同 session 隔离无法安全落地，将保留独立 child Run 的持久化与结果链路，并明确报告未完成项，不用伪造成功状态。