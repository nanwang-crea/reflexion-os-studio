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
      enum: [
        'get',
        'create',
        'update_step',
        'modify_plan',
        'complete_plan',
        'cancel_plan',
      ],
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
- 如果已经存在活动计划，禁止再次 create；必须沿用已有 planId 推进（update_step）或整体调整
  （modify_plan）。
- 不要自创 action。action 只能是：get、create、update_step、modify_plan、complete_plan、cancel_plan。
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

/**
 * create 与 modify_plan 共用的 goal/steps 参数解析。
 * 返回 { goal, steps } 或 { error }（结构化错误，直接回传模型）。
 */
function parseGoalAndSteps(
  input: Record<string, unknown>,
): { goal: string; steps: Array<{ id: string; title: string }> } | { error: ToolResult } {
  const goal = input.goal
  const rawSteps = input.steps
  if (
    typeof goal !== 'string' ||
    !goal.trim() ||
    !Array.isArray(rawSteps) ||
    rawSteps.length === 0
  )
    return {
      error: errorResult(
        'invalid_request',
        '需要 goal 和非空 steps 数组（每项含 id 与 title）',
      ),
    }
  const steps: Array<{ id: string; title: string }> = []
  for (const item of rawSteps) {
    if (typeof item !== 'object' || item === null)
      return { error: errorResult('invalid_request', 'invalid step') }
    const step = item as Record<string, unknown>
    if (
      typeof step.id !== 'string' ||
      typeof step.title !== 'string' ||
      !step.id.trim() ||
      !step.title.trim()
    )
      return {
        error: errorResult('invalid_request', 'step requires id and title'),
      }
    steps.push({ id: step.id, title: step.title })
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length)
    return {
      error: errorResult(
        'STEP_ID_CONFLICT',
        '计划内存在重复的步骤 id',
      ),
    }
  return { goal, steps }
}

async function executeManagePlan(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const action = input.action
  if (action === 'update') {
    return errorResult(
      'invalid_request',
      "action 'update' 已废弃：请使用 update_step 推进已有步骤，create 新建计划，或 modify_plan 整体调整已有计划",
    )
  }
  if (action === 'get') {
    // 只读：planId 可选。缺省时返回当前会话的活动计划（create 的事务内检查保证
    // 会话级唯一），无活动计划时返回 null；这是模型在上下文丢失时从 canonical
    // 状态恢复现场的最低成本通道。
    const requestedId =
      typeof input.planId === 'string' && input.planId.trim()
        ? input.planId.trim()
        : null
    if (requestedId) {
      const plan = ctx.store.plans.get(requestedId)
      if (!plan || plan.sessionId !== ctx.sessionId)
        return errorResult(
          'invalid_request',
          'plan does not belong to current session',
        )
      return { content: JSON.stringify(plan), isError: false }
    }
    const active = ctx.store.plans.getActive(ctx.sessionId)
    return { content: JSON.stringify(active), isError: false }
  }
  if (action === 'create' || action === 'modify_plan') {
    // create 与 modify_plan 的参数形状相同（goal + 全量 steps），共用解析逻辑；
    // create 额外要求当前没有活动计划，modify_plan 要求 planId 指向本会话活动计划。
    const parsed = parseGoalAndSteps(input)
    if ('error' in parsed) return parsed.error
    if (action === 'modify_plan') {
      const planId = input.planId
      if (typeof planId !== 'string' || !planId.trim())
        return errorResult(
          'invalid_request',
          'modify_plan 需要 planId（仅 get 的 planId 可省略）；记不清 planId 时先调用 get（不带 planId）找回当前活动计划',
        )
      const existing = ctx.store.plans.get(planId)
      if (!existing || existing.sessionId !== ctx.sessionId)
        return errorResult(
          'invalid_request',
          'plan does not belong to current session',
        )
      try {
        const modified = ctx.store.plans.modify(planId, {
          goal: parsed.goal,
          steps: parsed.steps,
        })
        ctx.emitter.next({ type: 'plan.updated', plan: modified })
        return { content: JSON.stringify(modified), isError: false }
      } catch (error) {
        return mapPlanError(error)
      }
    }
    try {
      const plan = ctx.store.plans.create({
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        goal: parsed.goal,
        steps: parsed.steps,
      })
      ctx.emitter.next({ type: 'plan.created', plan })
      return { content: JSON.stringify(plan), isError: false }
    } catch (error) {
      return mapPlanError(error)
    }
  }
  const planId = input.planId
  if (typeof planId !== 'string' || !planId.trim())
    return errorResult(
      'invalid_request',
      `${String(action)} 需要 planId（仅 get 的 planId 可省略）；记不清 planId 时先调用 get（不带 planId）找回当前活动计划`,
    )
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
