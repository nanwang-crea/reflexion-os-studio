import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue, PlanStepStatus } from '@reflexion-os-studio/contracts'
import { PlanError } from '../../store/plans.js'
import type { ToolContext } from './shared.js'

/**
 * manage_plan 的 canonical 参数声明。
 * 采用扁平 object schema（与仓库其它工具一致）：oneOf 判别联合会让 OpenAI 兼容
 * 端点误解 schema，导致模型以空参数 {} 调用并收到 invalid_request（见
 * docs/UPDATE-PLAN-TOOL-REDESIGN.md）。跨 action 的参数约束由运行时
 * executeManagePlan 校验，schema 只约束字段格式与 action 枚举。
 */
const MANAGE_PLAN_SCHEMA: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update_step', 'complete_plan', 'cancel_plan'],
    },
    goal: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
        },
        required: ['id', 'title'],
      },
    },
    planId: { type: 'string', minLength: 1 },
    stepId: { type: 'string', minLength: 1 },
    status: {
      type: 'string',
      enum: ['in_progress', 'completed', 'skipped', 'cancelled'],
    },
    note: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['action'],
}

const MANAGE_PLAN_DESCRIPTION = `管理当前任务的活动计划及其步骤。仅在任务确实包含多个需要跟踪的步骤时使用；简单任务不要创建计划。

核心约束：
- 同一任务同一时刻最多存在一个活动计划。
- 如果已经存在活动计划，禁止再次 create；必须沿用已有 planId，使用 update_step 推进步骤。
- 不要自创 action。action 只能是：create、update_step、complete_plan、cancel_plan。
- 工具返回错误时，先根据错误信息修正参数，再重试；禁止使用相同参数盲目重试。

动作：
1. create
   创建活动计划。必须提供 goal 和 steps。
   每个步骤必须包含 id 和 title；id 在同一计划内必须唯一，创建后不可复用。
   步骤 id 建议使用带唯一前缀的形式（如 plan-s1-<名称>），避免与历史计划冲突。
   新建步骤状态固定为 pending；create 时不要传步骤 status。

2. update_step
   推进已有计划中的一个步骤。必须提供 planId、stepId 和 status。
   正常步骤必须按 pending → in_progress → completed 依次流转；禁止从 pending 直接变为
   completed，已 completed 的步骤不可回退或重新打开。
   status 也可以是 skipped 或 cancelled，用于明确放弃某个步骤；这些是终止状态，不可再次推进。
   某次尝试受挫时步骤保持 in_progress，修正后重试即可；可选 note 记录进展或结果。

3. complete_plan
   在所有必要步骤都已 completed 或 skipped 后结束计划。必须提供 planId；可选 summary。
   不得在仍有未处理步骤时调用。

4. cancel_plan
   在用户明确放弃整个任务时将计划标记为取消。必须提供 planId；可选 summary 或 note。

计划卫生（必读）：
- 创建前检查：create 之前先在上下文中确认当前没有活动计划；已有活动计划时禁止
  再 create，应沿用该 planId 推进或收尾。
- 收尾检查：任务收尾时检查活动计划——必要步骤已全部终态则调用 complete_plan；
  目标已明显失效（被取代、演示完成等）可调用 cancel_plan 并在 note 说明原因；
  拿不准计划是否还有用时，先询问用户再决定，不要留一个无人推进的活动计划占位。

状态规则：
- 计划状态：active → completed 或 cancelled；终止状态不可回退。
- 步骤状态：pending → in_progress → completed；也可从 pending 或 in_progress 进入
  skipped 或 cancelled。
- 状态流转属于运行时状态机，调用参数 schema 只能校验字段格式，不能替代运行时校验。`

function errorResult(code: string, message: string): ToolResult {
  return { content: message, isError: true, code }
}

/** 领域状态机错误折叠为结构化错误码回传模型（见 REDESIGN 文档的 PLAN_* 码）。 */
function mapPlanError(error: unknown): ToolResult {
  if (error instanceof PlanError) {
    return errorResult(error.code, error.message)
  }
  return errorResult(
    'tool_error',
    `计划操作失败：${error instanceof Error ? error.message : String(error)}`,
  )
}

async function executeManagePlan(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const action = input.action
  if (action === 'update') {
    return errorResult(
      'invalid_request',
      "action 'update' 已废弃：请使用 update_step 推进已有步骤，或 create 新建计划",
    )
  }
  if (action === 'create') {
    const goal = input.goal
    const rawSteps = input.steps
    if (
      typeof goal !== 'string' ||
      !goal.trim() ||
      !Array.isArray(rawSteps) ||
      rawSteps.length === 0
    )
      return errorResult('invalid_request', 'create 需要 goal 和 steps')
    const steps: Array<{ id: string; title: string }> = []
    for (const item of rawSteps) {
      if (typeof item !== 'object' || item === null)
        return errorResult('invalid_request', 'invalid step')
      const step = item as Record<string, unknown>
      if (
        typeof step.id !== 'string' ||
        typeof step.title !== 'string' ||
        !step.id.trim() ||
        !step.title.trim()
      )
        return errorResult('invalid_request', 'step requires id and title')
      steps.push({ id: step.id, title: step.title })
    }
    if (new Set(steps.map((step) => step.id)).size !== steps.length)
      return errorResult('STEP_ID_CONFLICT', '计划内存在重复的步骤 id')
    try {
      const plan = ctx.store.plans.create({
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        goal,
        steps,
      })
      ctx.emitter.next({ type: 'plan.created', plan })
      return { content: JSON.stringify(plan), isError: false }
    } catch (error) {
      return mapPlanError(error)
    }
  }
  const planId = input.planId
  if (typeof planId !== 'string' || !planId.trim())
    return errorResult('invalid_request', 'planId is required')
  const plan = ctx.store.plans.get(planId)
  if (!plan || plan.sessionId !== ctx.sessionId)
    return errorResult(
      'invalid_request',
      'plan does not belong to current session',
    )
  if (action === 'update_step') {
    if (typeof input.stepId !== 'string' || typeof input.status !== 'string')
      return errorResult('invalid_request', 'stepId and status are required')
    try {
      const step = ctx.store.plans.updateStep(
        planId,
        input.stepId,
        input.status as PlanStepStatus,
        typeof input.note === 'string' ? input.note : null,
      )
      if (input.status === 'in_progress') {
        ctx.store.runs.attachPlan(ctx.runId, planId, input.stepId)
      }
      ctx.emitter.next({ type: 'plan.step.updated', planId, step })
      return { content: JSON.stringify(step), isError: false }
    } catch (error) {
      return mapPlanError(error)
    }
  }
  if (action === 'complete_plan' || action === 'cancel_plan') {
    // summary 可选；未提供时回退到 note（Plan 实体只有 summary 一个收尾字段）。
    const summary =
      (typeof input.summary === 'string' && input.summary.trim()
        ? input.summary.trim()
        : null) ??
      (typeof input.note === 'string' && input.note.trim()
        ? input.note.trim()
        : null)
    try {
      const finished =
        action === 'complete_plan'
          ? ctx.store.plans.complete(planId, summary)
          : ctx.store.plans.cancel(planId, summary)
      ctx.emitter.next({ type: 'plan.updated', plan: finished })
      return { content: JSON.stringify(finished), isError: false }
    } catch (error) {
      return mapPlanError(error)
    }
  }
  return errorResult('invalid_request', 'unsupported action')
}

/** 统一入口：manage_plan（新名）。 */
export function createManagePlanTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'manage_plan',
    description: MANAGE_PLAN_DESCRIPTION,
    parameters: MANAGE_PLAN_SCHEMA,
    execute: ({ args }: { args: JsonValue }) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        return errorResult('invalid_request', 'arguments must be an object')
      return executeManagePlan(ctx, args as Record<string, unknown>)
    },
  }
}

/** 兼容别名：update_plan 映射到同一实现；禁止未定义的 action: update。 */
export function createLegacyUpdatePlanTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'update_plan',
    description:
      '（已废弃，请改用 manage_plan）创建或更新当前任务计划。仅复杂、多步骤任务使用；简单问题直接回答。',
    parameters: MANAGE_PLAN_SCHEMA,
    execute: ({ args }: { args: JsonValue }) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        return errorResult('invalid_request', 'arguments must be an object')
      return executeManagePlan(ctx, args as Record<string, unknown>)
    },
  }
}
