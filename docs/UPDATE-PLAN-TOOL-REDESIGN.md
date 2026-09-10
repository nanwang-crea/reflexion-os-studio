# 计划工具重设计：方案 A + 方案 B（已决策：改名 manage_plan）

> 本文是平台层工具定义的可直接落地规格。已按本文在 `apps/runtime/src/agent/tools/plans.ts`
> 落地 `manage_plan` 工具（含结构化错误码与 `update_plan` 兼容别名），并同步更新 system
> prompt、工具白名单、审批策略与测试夹具。

> **修订记录（2026-09-10）**：新增只读 `get` 动作（无副作用；`planId` 可选，缺省返回当前
> 会话活动计划，无则返回 `null`）——计划的 canonical 状态在 SQLite（`plans`/`plan_steps`），
> 模型确认活动计划应读 canonical 状态而非依赖上下文记忆；`PLAN_ALREADY_EXISTS` 错误消息
> 同步改为回显活动计划的 planId/goal/各步骤状态，使错误通道本身可自纠。同时按当前实现
> 对齐：移除描述中的 `fail_plan`（实现无此 action），步骤状态枚举不含 `failed`。

> **修订记录（2026-09-10，其二）**：新增 `modify_plan` 动作——原地整体修改当前活动计划
> （planId 不变）：必须提供 planId、goal 与 steps 全量规格；与新规格同 id 的步骤保留
> status/note（仅更新 title），全新 id 插入为 pending，未出现在新规格中的步骤被删除。
> 解决"已有活动计划时无法调整计划结构"的痛点（此前只能 cancel + create，丢 planId、
> 丢进度且易触发 `PLAN_ALREADY_EXISTS`）。同步把 `planId is required` 类错误消息改为
> 自纠格式（提示先 get 找回 planId），并在描述与 system prompt 中明确
> "步骤级动作 planId 必填、仅 get 可省略"。

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
- 如果已经存在活动计划，禁止再次 create；必须沿用已有 planId 推进（update_step）或整体
  调整（modify_plan）。
- 不要自创 action。action 只能是：get、create、update_step、modify_plan、complete_plan、
  cancel_plan。
- 工具返回错误时，先根据错误信息修正参数，再重试；禁止使用相同参数盲目重试。

动作：
1. get
   只读查询，无副作用。不确定当前是否已有活动计划、或记不清 planId/步骤状态时先调用它，
   再决定后续动作；不要凭上下文记忆猜测。可省略 planId（返回当前会话的活动计划，
   无活动计划时返回 null）；提供 planId 时返回该计划详情（限本会话）。

2. create
   创建活动计划。必须提供 goal 和 steps。
   每个步骤必须包含 id 和 title；id 在同一计划内必须唯一，创建后不可复用。
   步骤 id 建议使用带唯一前缀的形式（如 plan-s1-<名称>），避免与历史计划冲突。
   新建步骤状态固定为 pending；create 时不要传步骤 status。
   create 之前先 get 确认当前没有活动计划。

3. update_step
   推进已有计划中的一个步骤。必须提供 planId、stepId 和 status。
   正常步骤必须按 pending → in_progress → completed 依次流转；禁止从 pending 直接变为
   completed，已 completed 的步骤不可回退或重新打开。
   status 也可以是 skipped 或 cancelled，用于明确放弃某个步骤；这些是终止状态，不可再次推进。
   某次尝试受挫时步骤保持 in_progress，修正后重试即可；可选 note 记录进展或结果。

4. modify_plan
   原地整体修改当前活动计划（planId 不变）。必须提供 planId、goal 和 steps（声明式全量规格）。
   合并规则：与新规格同 id 的步骤保留 status/note，仅更新 title（改标题不算重做）；
   全新 id 的步骤插入为 pending；未出现在新规格中的现有步骤被删除。
   需要重做已完成的工作时用新步骤 id（如 plan-s3-verify-v2）表达，不要复用已完成步骤的 id。
   仅允许修改 active 状态的计划；适用于范围变化、步骤增减、目标修正等计划修订场景。

5. complete_plan
   在所有必要步骤都已 completed 或 skipped 后结束计划。必须提供 planId；可选 summary。
   不得在仍有未处理步骤时调用。

6. cancel_plan
   在用户明确放弃整个任务时将计划标记为取消。必须提供 planId；可选 summary 或 note。

计划卫生（必读）：
- 创建前检查：create 之前先用 get 确认当前没有活动计划（读 canonical 状态，不靠上下文记忆）；
  已有活动计划时禁止再 create，应沿用返回的 planId 推进（update_step）、整体调整（modify_plan）
  或收尾（complete_plan/cancel_plan）。
- 收尾检查：任务收尾时先用 get 确认活动计划状态——必要步骤已全部终态则调用 complete_plan；
  目标已明显失效（被取代、演示完成等）可调用 cancel_plan 并在 note 说明原因；
  拿不准计划是否还有用时，先询问用户再决定，不要留一个无人推进的活动计划占位。

planId 规则：
- 仅 get 的 planId 可省略；create 不需要 planId；其余动作（update_step/modify_plan/
  complete_plan/cancel_plan）都必须提供 planId，缺失会被拒绝。
- 记不清 planId 时先调用 get（省略 planId）找回当前活动计划，不要凭记忆猜测。

状态规则：
- 计划状态：active → completed 或 cancelled；终止状态不可回退。
- 步骤状态：pending → in_progress → completed；也可从 pending 或 in_progress 进入
  skipped 或 cancelled。
- 状态流转属于运行时状态机，调用参数 schema 只能校验字段格式，不能替代运行时校验。
```

## 3. 方案 B：JSON Schema（已修订为扁平 schema，弃用 oneOf）

> **修订记录（2026-09-07）**：最初按本文落地的是 `oneOf` 判别联合。实测中 OpenAI 兼容
> 端点对 `oneOf` 支持不佳，模型读不到必填 `action`，一律以空参数 `{}` 调用工具，连续
> 触发 `invalid_request`（数据库 `tool_calls` 中 `args_json` 全为 `{}`）。故 schema 改回
> 与仓库其它工具一致的**扁平 `type: object`**：只声明字段格式与 `action` 枚举，跨 action
> 的必填/互斥约束由运行时 `executeManagePlan` 校验（该实现本就存在，不受影响）。

```json
{
  "name": "manage_plan",
  "description": "管理当前任务的活动计划及其步骤。仅多步骤任务使用。每个任务最多一个活动计划；已有计划时禁止重复 create，必须沿用已有 planId（update_step 推进 / modify_plan 整体调整）。action 只能是 get、create、update_step、modify_plan、complete_plan、cancel_plan（get 为只读查询，planId 可选，缺省返回当前会话活动计划，无则返回 null；其余步骤级动作 planId 必填）。modify_plan 原地整体修改活动计划：goal + steps 全量规格，同 id 保留进度、新 id 新增 pending、缺失 id 删除。步骤状态必须按 pending → in_progress → completed 依次流转；不得跳过中间状态；终止状态不可回退。工具报错后先修正参数，不要用相同参数盲目重试。",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "get",
          "create",
          "update_step",
          "modify_plan",
          "complete_plan",
          "cancel_plan"
        ]
      },
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
      },
      "planId": { "type": "string", "minLength": 1 },
      "stepId": { "type": "string", "minLength": 1 },
      "status": {
        "type": "string",
        "enum": ["in_progress", "completed", "skipped", "cancelled"]
      },
      "note": { "type": "string" },
      "summary": { "type": "string" }
    },
    "required": ["action"]
  }
}
```

> 注：扁平 schema 只能约束字段格式，无法表达"create 必须带 goal/steps"、"update_step
> 必须带 planId/stepId/status"等按 action 区分的必填关系；这些由运行时校验返回结构化
> 错误码，模型据错误自纠（planId 类错误消息会提示先 get 找回 planId）。这不是功能回退
> ——原来的 `oneOf` 版本同样没有运行时校验能力，而空参问题已实测比"让模型理解判别联合"
> 更值得优先解决。

### Schema 不能解决的约束

以下规则必须由工具实现或服务端状态机保证：

- 同一任务只能有一个 active plan。
- step id 在一个 plan 内唯一，且不能与已有步骤冲突。
- `pending → in_progress → completed` 的跨调用顺序。
- completed/skipped/cancelled 等终止状态不可回退。
- complete_plan 前必须没有未处理步骤。

建议服务端把非法流转返回结构化错误，例如：`PLAN_ALREADY_EXISTS`、`STEP_ID_CONFLICT`、
`INVALID_STEP_TRANSITION`、`PLAN_NOT_READY_TO_COMPLETE`，便于模型据错误自纠。

> 注：本仓库运行时对 `plan_steps.id` 的 UNIQUE 约束是全局级别（跨计划），因此"步骤 id
> 全局唯一"比文档要求的"计划内唯一"更严。新计划应使用带唯一前缀的步骤 id（如 `s1` 改为
> `plan-<seq>-<step>`），避免与历史计划冲突——这也是本次重设计中要明确写入描述的原因。

## 4. 命名决策与兼容迁移

### 最终命名：`manage_plan`

- 语义覆盖完整生命周期（get / create / update_step / modify_plan / complete_plan / cancel_plan），
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

不确定是否有活动计划时，先只读查询（planId 可省略，无活动计划返回 null）：

```json
{
  "action": "get"
}
```

确认没有活动计划时再创建：

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
{
  "action": "update_step",
  "planId": "pl_123",
  "stepId": "plan-s1-scan",
  "status": "in_progress"
}
```

```json
{
  "action": "update_step",
  "planId": "pl_123",
  "stepId": "plan-s1-scan",
  "status": "completed",
  "note": "扫描完成，发现 2 处问题"
}
```

执行中发现范围变化时，原地整体调整计划（planId 不变；保留的步骤 id 沿用，
新增 id 用新前缀，不再需要的 id 直接不写即可删除）：

```json
{
  "action": "modify_plan",
  "planId": "pl_123",
  "goal": "扫描并修复项目中的路由问题，并补充回归验证",
  "steps": [
    { "id": "plan-s1-scan", "title": "扫描相关代码" },
    { "id": "plan-s1-fix", "title": "修复实现" },
    { "id": "plan-s1-regression", "title": "补充回归验证" }
  ]
}
```

上面的例子中 `plan-s1-verify` 被移除（未出现在新规格中），`plan-s1-scan` 的
status/note 原样保留；若需重做已完成的扫描，应使用新 id（如 `plan-s1-scan-v2`）。

只有在后续步骤也完成后，才能调用：

```json
{ "action": "complete_plan", "planId": "pl_123", "summary": "全部步骤已完成" }
```
