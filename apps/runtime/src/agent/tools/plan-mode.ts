import type {
  JsonValue,
  UserQuestionAnswer,
} from '@reflexion-os-studio/contracts'
import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'
import type { ToolContext } from './shared.js'
import { requireString } from './shared.js'
import {
  cleanupPlanDocuments,
  reviewPlanDocument,
  validatePlanSnapshot,
} from './plan-documents.js'
import type { PlanSnapshot } from '@reflexion-os-studio/contracts'
import type { SystemRuntimeClient } from '../../system.js'

const NO_ARGS: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const EXIT_ARGS: JsonValue = {
  type: 'object',
  additionalProperties: false,
  required: ['planId'],
  properties: {
    planId: { type: 'string', minLength: 1 },
  },
}

export function createEnterPlanModeTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'enter_plan_mode',
    description:
      '进入只读计划模式。在该模式中只能调研、提问和维护计划，Runtime 会强制拒绝文件写入、Shell、MCP、记忆写入与子 Agent 委派。完成具体计划后调用 exit_plan_mode 请求用户批准。',
    parameters: NO_ARGS,
    execution: { effect: 'state', idempotent: true },
    execute() {
      const previousMode =
        ctx.store.sessions.get(ctx.sessionId)?.executionMode ?? 'execute'
      const session = ctx.store.sessions.setExecutionMode(ctx.sessionId, 'plan')
      return {
        content:
          '已进入计划模式。请只读调研，使用 manage_plan 创建或修改具体计划；需要用户决策时调用 ask_user，准备完成后调用 exit_plan_mode。',
        isError: false,
        data: { previousMode, mode: session.executionMode },
      }
    },
  }
}

export function createExitPlanModeTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'exit_plan_mode',
    description:
      '提交当前活动计划供用户批准。只有用户选择批准后才退出只读计划模式；要求修改或取消时保持计划模式。planId 必须属于当前会话且仍为 active。',
    parameters: EXIT_ARGS,
    execution: { effect: 'state', idempotent: false },
    async execute({ args, signal, toolCallId }) {
      const planId = requireString(args, 'planId')
      const session = ctx.store.sessions.get(ctx.sessionId)
      if (session?.executionMode !== 'plan') {
        return {
          content: '当前不在计划模式，不能请求退出。',
          isError: true,
          code: 'invalid_state',
        }
      }
      const plan = ctx.store.plans.get(planId)
      if (
        !plan ||
        plan.sessionId !== ctx.sessionId ||
        plan.status !== 'active'
      ) {
        return {
          content: '指定计划不存在、不属于当前会话或已结束。',
          isError: true,
          code: 'invalid_request',
        }
      }
      let snapshot: PlanSnapshot
      try {
        snapshot = await reviewPlanDocument(ctx.store, ctx.system, plan)
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
          code: 'plan_document_required',
        }
      }
      const answers = await ctx.interactions.requestQuestions({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId,
        kind: 'plan_approval',
        questions: [
          {
            id: 'plan-decision',
            plan: snapshot,
            header: '计划审批',
            question: `是否批准执行计划“${plan.goal.slice(0, 400)}”？`,
            multiSelect: false,
            options: [
              {
                id: 'approve',
                label: '批准并执行',
                description: '退出只读计划模式，允许按当前权限执行计划。',
              },
              {
                id: 'revise',
                label: '需要修改',
                description: '保持计划模式，并根据反馈调整计划。',
              },
              {
                id: 'cancel',
                label: '取消计划',
                description: '取消当前计划并保持只读计划模式。',
              },
            ],
          },
        ],
        emitter: ctx.emitter,
        signal,
      })
      const result = await applyPlanApproval(
        ctx.store,
        ctx.sessionId,
        planId,
        answers,
        snapshot,
        ctx.system,
      )
      const current = ctx.store.plans.get(planId)
      if (current?.status === 'cancelled')
        ctx.emitter.next({ type: 'plan.updated', plan: current })
      return result
    },
  }
}

/** 计划审批的确定性状态推进；实时执行与重启恢复共用，避免语义分叉。 */
export async function applyPlanApproval(
  store: Store,
  sessionId: string,
  planId: string,
  answers: UserQuestionAnswer[],
  snapshot?: PlanSnapshot,
  system: SystemRuntimeClient | null = null,
): Promise<ToolResult> {
  const answer = answers.find((item) => item.questionId === 'plan-decision')
  const decision = answer?.selectedOptionIds[0] ?? 'revise'
  const plan = store.plans.get(planId)
  if (!plan || plan.sessionId !== sessionId || plan.status !== 'active')
    return {
      content: '计划已失效，请重新提交审批。',
      isError: true,
      code: 'stale_plan',
    }
  if (decision === 'approve') {
    let valid = false
    try {
      valid =
        snapshot !== undefined &&
        snapshot.planId === planId &&
        (await validatePlanSnapshot(store, system, sessionId, snapshot))
    } catch {
      /* fail closed */
    }
    if (!valid)
      return {
        content: '计划内容已变更或文件不可读取，请保持计划模式并重新提交审批。',
        isError: true,
        code: 'stale_plan',
      }
    const document = store.planDocuments.get(planId)
    if (document && answer?.keepPlan)
      store.planDocuments.save({ ...document, retained: true })
    store.sessions.setExecutionMode(sessionId, 'execute')
    return {
      content: `用户已批准下列计划。已退出计划模式，按本次审批版本执行：\n\n${snapshot!.markdown}`,
      isError: false,
      data: {
        approved: true,
        planId,
        mode: 'execute',
        planSnapshot: snapshot!,
      },
    }
  }
  if (decision === 'cancel') {
    const document = store.planDocuments.get(planId)
    if (document && answer?.keepPlan)
      store.planDocuments.save({ ...document, retained: true })
    store.plans.cancel(planId, answer?.customText ?? '用户取消计划')
    await cleanupPlanDocuments(store, system)
    return {
      content: '用户取消了计划。保持计划模式，不要执行。',
      isError: false,
      data: {
        approved: false,
        cancelled: true,
        planId,
        mode: 'plan',
        ...(snapshot ? { planSnapshot: snapshot } : {}),
      },
    }
  }
  const feedback = answer?.customText?.trim()
  return {
    content: feedback
      ? `用户要求修改计划：${feedback}`
      : '用户未批准当前计划。请保持计划模式并调整计划。',
    isError: false,
    data: {
      approved: false,
      cancelled: false,
      planId,
      mode: 'plan',
      ...(snapshot ? { planSnapshot: snapshot } : {}),
      ...(feedback ? { feedback } : {}),
    },
  }
}
