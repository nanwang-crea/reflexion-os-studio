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
      const answers = await ctx.interactions.requestQuestions({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId,
        kind: 'plan_approval',
        questions: [
          {
            id: 'plan-decision',
            header: '计划审批',
            question: `是否批准执行计划“${plan.goal}”？`,
            multiSelect: false,
            options: [
              {
                id: 'approve',
                label: '批准并开始（推荐）',
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
      return applyPlanApproval(ctx.store, ctx.sessionId, planId, answers)
    },
  }
}

/** 计划审批的确定性状态推进；实时执行与重启恢复共用，避免语义分叉。 */
export function applyPlanApproval(
  store: Store,
  sessionId: string,
  planId: string,
  answers: UserQuestionAnswer[],
): ToolResult {
  const answer = answers.find((item) => item.questionId === 'plan-decision')
  const decision = answer?.selectedOptionIds[0] ?? 'revise'
  if (decision === 'approve') {
    store.sessions.setExecutionMode(sessionId, 'execute')
    return {
      content: '用户已批准计划。已退出计划模式，可以开始执行。',
      isError: false,
      data: { approved: true, planId, mode: 'execute' },
    }
  }
  if (decision === 'cancel') {
    store.plans.cancel(planId, answer?.customText ?? '用户取消计划')
    return {
      content: '用户取消了计划。保持计划模式，不要执行。',
      isError: false,
      data: { approved: false, cancelled: true, planId, mode: 'plan' },
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
      ...(feedback ? { feedback } : {}),
    },
  }
}
