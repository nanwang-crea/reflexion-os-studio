import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { ToolContext } from './shared.js'

export function createUpdatePlanTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'update_plan',
    description:
      '创建或更新当前任务计划。仅复杂、多步骤任务使用；简单问题直接回答。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'update_step',
            'complete_plan',
            'fail_plan',
            'cancel_plan',
          ],
        },
        planId: { type: 'string' },
        goal: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
        stepId: { type: 'string' },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'failed', 'skipped', 'cancelled'],
        },
        note: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['action'],
    },
    execute: ({ args }: { args: JsonValue }) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        throw new Error('arguments must be an object')
      const input = args as Record<string, unknown>
      const action = input.action
      if (action === 'create') {
        const goal = input.goal
        const rawSteps = input.steps
        if (
          typeof goal !== 'string' ||
          !goal.trim() ||
          !Array.isArray(rawSteps) ||
          rawSteps.length === 0
        )
          throw new Error('create requires goal and steps')
        const steps = rawSteps.map((item) => {
          if (typeof item !== 'object' || item === null)
            throw new Error('invalid step')
          const step = item as Record<string, unknown>
          if (
            typeof step.id !== 'string' ||
            typeof step.title !== 'string' ||
            !step.id.trim() ||
            !step.title.trim()
          )
            throw new Error('step requires id and title')
          return { id: step.id, title: step.title }
        })
        if (new Set(steps.map((step) => step.id)).size !== steps.length)
          throw new Error('duplicate step id')
        const plan = ctx.store.plans.create({
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          goal,
          steps,
        })
        ctx.emitter.next({ type: 'plan.created', plan })
        return Promise.resolve({
          content: JSON.stringify(plan),
          isError: false,
        })
      }
      const planId = input.planId
      if (typeof planId !== 'string' || !planId.trim())
        throw new Error('planId is required')
      const plan = ctx.store.plans.get(planId)
      if (!plan || plan.sessionId !== ctx.sessionId)
        throw new Error('plan does not belong to current session')
      if (action === 'update_step') {
        if (
          typeof input.stepId !== 'string' ||
          typeof input.status !== 'string'
        )
          throw new Error('stepId and status are required')
        const step = ctx.store.plans.updateStep(
          planId,
          input.stepId,
          input.status as never,
          typeof input.note === 'string' ? input.note : null,
        )
        if (input.status === 'in_progress') {
          ctx.store.runs.attachPlan(ctx.runId, planId, input.stepId)
        }
        ctx.emitter.next({ type: 'plan.step.updated', planId, step })
        return Promise.resolve({
          content: JSON.stringify(step),
          isError: false,
        })
      }
      if (
        action === 'complete_plan' ||
        action === 'fail_plan' ||
        action === 'cancel_plan'
      ) {
        if (typeof input.summary !== 'string' || !input.summary.trim())
          throw new Error('summary is required')
        const completed =
          action === 'complete_plan'
            ? ctx.store.plans.complete(planId, input.summary)
            : action === 'fail_plan'
              ? ctx.store.plans.fail(planId, input.summary)
              : ctx.store.plans.cancel(planId, input.summary)
        ctx.emitter.next({ type: 'plan.updated', plan: completed })
        return Promise.resolve({
          content: JSON.stringify(completed),
          isError: false,
        })
      }
      throw new Error('unsupported action')
    },
  }
}
