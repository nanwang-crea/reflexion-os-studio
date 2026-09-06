# 计划工具重设计：方案 A + 方案 B（已决策：改名 manage_plan）

> 本文是平台层工具定义的可直接落地规格。已按本文在 `apps/runtime/src/agent/tools/plans.ts`
> 落地 `manage_plan` 工具（含结构化错误码与 `update_plan` 兼容别名），并同步更新 system
> prompt、工具白名单、审批策略与测试夹具。

## 1. 结论摘要

原工具名 `update_plan` 不合适：它实际覆盖计划的创建、步骤推进、完成、失败和取消，不只是 update，
且"update"语义会诱导模型构造不存在的 `action: "update"`。

**最终决策：更名为 `manage_plan`**，作为"计划生命周期管理"的统一入口，已按本文落地。

## 2. 方案 A：工具描述（最终版）

以下描述可直接替换工具的 description：

```text
管理当前任务的活动计划及其步骤。仅在任务确实包含多个需要跟踪的步骤时使用；简单任务不要创建计划。

核心约束：
- 同一任务同一时刻最多存在一个活动计划。
- 如果已经存在活动计划，禁止再次 create；必须沿用已有 planId，使用 update_step 推进步骤。
- 不要自创 action。action 只能是：create、update_step、complete_plan、fail_plan、cancel_plan。
- 工具返回错误时，先根据错误信息修正参数，再重试；禁止使用相同参数盲目重试。

动作：
1. create
   创建活动计划。必须提供 goal 和 steps。
   每个步骤必须包含 id 和 title；id 在同一计划内必须唯一，创建后不可复用。
   新建步骤状态固定为 pending；create 时不要传步骤 status。

2. update_step
   推进已有计划中的一个步骤。必须提供 planId、stepId 和 status。
   正常步骤必须按 pending → in_progress → completed 依次流转；禁止从 pending 直接变为
   completed，已 completed 的步骤不可回退或重新打开。
   status 也可以是 failed、skipped 或 cancelled，但这些是终止状态；终止状态不可再次推进。
   可选 note 记录该步骤的进展、结果或失败原因。

3. complete_plan
   在所有必要步骤都已 completed 或 skipped 后结束计划。必须提供 planId；可选 summary。
   不得在仍有未处理步骤时调用。

4. fail_plan
   在计划无法继续时将计划标记为失败。必须提供 planId；可选 summary 或 note。

5. cancel_plan
   在用户或系统取消任务时将计划标记为取消。必须提供 planId；可选 summary 或 note。

状态规则：
- 计划状态：active → completed、failed 或 cancelled；终止状态不可回退。
- 步骤状态：pending → in_progress → completed；也可从 pending 或 in_progress 进入
  failed、skipped 或 cancelled。
- 状态流转属于运行时状态机，调用参数 schema 只能校验字段格式，不能替代运行时校验。
```

## 3. 方案 B：JSON Schema（最终版）

```json
{
  "name": "manage_plan",
  "description": "管理当前任务的活动计划及其步骤。仅多步骤任务使用。每个任务最多一个活动计划；已有计划时禁止重复 create，必须使用已有 planId 的 update_step。action 只能是 create、update_step、complete_plan、fail_plan、cancel_plan。步骤状态必须按 pending → in_progress → completed 依次流转；不得跳过中间状态；终止状态不可回退。工具报错后先修正参数，不要用相同参数盲目重试。",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "oneOf": [
      {
        "title": "CreatePlan",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": { "const": "create" },
          "goal": { "type": "string", "minLength": 1 },
          "steps": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1 }
              },
              "required": ["id", "title"]
            }
          }
        },
        "required": ["action", "goal", "steps"]
      },
      {
        "title": "UpdateStep",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": { "const": "update_step" },
          "planId": { "type": "string", "minLength": 1 },
          "stepId": { "type": "string", "minLength": 1 },
          "status": {
            "type": "string",
            "enum": ["in_progress", "completed", "failed", "skipped", "cancelled"]
          },
          "note": { "type": "string" }
        },
        "required": ["action", "planId", "stepId", "status"]
      },
      {
        "title": "CompletePlan",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": { "const": "complete_plan" },
          "planId": { "type": "string", "minLength": 1 },
          "summary": { "type": "string" }
        },
        "required": ["action", "planId"]
      },
      {
        "title": "FailPlan",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": { "const": "fail_plan" },
          "planId": { "type": "string", "minLength": 1 },
          "summary": { "type": "string" },
          "note": { "type": "string" }
        },
        "required": ["action", "planId"]
      },
      {
        "title": "CancelPlan",
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "action": { "const": "cancel_plan" },
          "planId": { "type": "string", "minLength": 1 },
          "summary": { "type": "string" },
          "note": { "type": "string" }
        },
        "required": ["action", "planId"]
      }
    ]
  }
}
```

### Schema 不能解决的约束

以下规则必须由工具实现或服务端状态机保证：

- 同一任务只能有一个 active plan。
- step id 在一个 plan 内唯一，且不能与已有步骤冲突。
- `pending → in_progress → completed` 的跨调用顺序。
- completed/failed/skipped/cancelled 等终止状态不可回退。
- complete_plan 前必须没有未处理步骤。

建议服务端把非法流转返回结构化错误，例如：`PLAN_ALREADY_EXISTS`、`STEP_ID_CONFLICT`、
`INVALID_STEP_TRANSITION`、`PLAN_NOT_READY_TO_COMPLETE`，便于模型据错误自纠。

> 注：本仓库运行时对 `plan_steps.id` 的 UNIQUE 约束是全局级别（跨计划），因此"步骤 id
> 全局唯一"比文档要求的"计划内唯一"更严。新计划应使用带唯一前缀的步骤 id（如 `s1` 改为
> `plan-<seq>-<step>`），避免与历史计划冲突——这也是本次重设计中要明确写入描述的原因。

## 4. 命名决策与兼容迁移

### 最终命名：`manage_plan`

- 语义覆盖完整生命周期（create / update_step / complete_plan / fail_plan / cancel_plan），
  与平台 Agent 侧工具注册名的 snake_case 风格一致（如 `skill_use`、`web_fetch`）。
- 不使用 `plan.manage`：虽然点分与协议层内置操作枚举（`file.read`、`shell.execute`）更一致，
  但 Agent 侧工具注册名与协议层操作枚举是**两个不同维度**，不宜混为一谈（见下节）。
- 不使用 `update_plan`：语义偏窄且诱导非法 `action: update`，仅保留兼容别名。

### 命名约定统一（老问题修复）

原 `packages/contracts/src/entities.ts` 的 `ApprovalOperationSchema` 注释把两种命名风格
并列作为示例——内置操作枚举用点分（`file.read`），动态工具名却用下划线（`update_plan`），
看起来像命名风格混用。本次统一如下（已同步修改源码注释）：

1. **协议层内置操作枚举（ToolOperation）**：点分命名，如 `file.read`、`shell.execute`。
   这是协议/权限/审批卡共享的稳定枚举值，保持不动。
2. **Agent 侧工具注册名**：snake_case，如 `manage_plan`、`skill_use`、`web_fetch`。
   它们不属于 ToolOperation 枚举，作为"任意动态工具名"被 ApprovalOperationSchema 接收。
3. 注释示例按所属维度各写各的风格，避免在同一句里并列两种风格：
   `（MCP 工具的 serverId/toolName、Agent 侧注册的 manage_plan 等，命名不在此枚举内）`。

### 迁移建议

1. 新工具注册为 `manage_plan`，description 和 schema 使用本文版本。
2. 旧 `update_plan` 保留一个兼容周期，仅作为别名映射到同一实现。
3. 兼容层不得接受未定义的 `action: update`；应返回明确错误并提示使用 `update_step`。
4. 同步更新 system prompt、工具白名单、审批展示、测试夹具和工具文档。
5. `planId`、`stepId` 和数据库实体无需改名；改的是工具公开名称，不是领域数据模型。

## 5. 正确调用顺序示例

```json
{
  "action": "create",
  "goal": "扫描并修复项目中的路由问题",
  "steps": [
    { "id": "plan-s1-scan", "title": "扫描相关代码" },
    { "id": "plan-s1-fix", "title": "修复实现" },
    { "id": "plan-s1-verify", "title": "运行验证" }
  ]
}
```

```json
{ "action": "update_step", "planId": "pl_123", "stepId": "plan-s1-scan", "status": "in_progress" }
```

```json
{ "action": "update_step", "planId": "pl_123", "stepId": "plan-s1-scan", "status": "completed", "note": "扫描完成，发现 2 处问题" }
```

只有在后续步骤也完成后，才能调用：

```json
{ "action": "complete_plan", "planId": "pl_123", "summary": "全部步骤已完成" }
```
