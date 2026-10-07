import { MANAGE_PLAN_DESCRIPTION } from '../prompts/manage-plan.js'
import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue, PlanStepStatus } from '@reflexion-os-studio/contracts'
import { PlanError } from '../../store/chat/plans.js'
import {
  cleanupPlanDocuments,
  reviewPlanDocument,
  writePlanDocument,
} from './plan-documents.js'
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
        'write_document',
        'retain_document',
      ],
    },
    markdown: { type: 'string', minLength: 1, maxLength: 100000 },
    retain: { type: 'boolean' },
    expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
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
):
  | { goal: string; steps: Array<{ id: string; title: string }> }
  | { error: ToolResult } {
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
      error: errorResult('STEP_ID_CONFLICT', '计划内存在重复的步骤 id'),
    }
  return { goal, steps }
}

async function executeManagePlan(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  await cleanupPlanDocuments(ctx.store, ctx.system)
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
      const document = ctx.store.planDocuments.get(plan.id)
        ? await reviewPlanDocument(ctx.store, ctx.system, plan)
        : null
      return { content: JSON.stringify({ ...plan, document }), isError: false }
    }
    const active = ctx.store.plans.getActive(ctx.sessionId)
    const document =
      active && ctx.store.planDocuments.get(active.id)
        ? await reviewPlanDocument(ctx.store, ctx.system, active)
        : null
    return {
      content: JSON.stringify(active ? { ...active, document } : null),
      isError: false,
    }
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
      const document = ctx.store.planDocuments.get(plan.id)
        ? await reviewPlanDocument(ctx.store, ctx.system, plan)
        : null
      return { content: JSON.stringify({ ...plan, document }), isError: false }
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
  if (action === 'write_document' || action === 'retain_document') {
    if (plan.status !== 'active')
      return errorResult('PLAN_TERMINAL', '计划已结束')
    try {
      if (action === 'write_document') {
        if (typeof input.markdown !== 'string')
          return errorResult('invalid_request', '需要 markdown 完整方案')
        const snapshot = await writePlanDocument(
          ctx,
          plan,
          input.markdown,
          typeof input.expectedSha256 === 'string'
            ? input.expectedSha256
            : undefined,
        )
        return {
          content: `计划方案已保存：${snapshot.path ?? '会话内计划文档'}。请提交 exit_plan_mode 供用户审阅。`,
          isError: false,
          data: { planSnapshot: snapshot },
        }
      }
      const document = ctx.store.planDocuments.get(planId)
      if (!document || typeof input.retain !== 'boolean')
        return errorResult(
          'invalid_request',
          '需要已登记的计划文件和 retain 布尔值',
        )
      ctx.store.planDocuments.save({ ...document, retained: input.retain })
      return {
        content: input.retain
          ? '计划文件将保留。'
          : '计划结束后将自动清理未被人工修改的文件。',
        isError: false,
      }
    } catch (error) {
      return mapPlanError(error)
    }
  }
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
      await cleanupPlanDocuments(ctx.store, ctx.system)
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
