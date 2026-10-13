import { workflowCommands } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../command-utils.js'
import { CommandError } from '../agent/errors.js'
import { validateWorkflow } from './graph/validate.js'
import { saveWorkflowDefinition } from './definitions/service.js'
import { workflowHash } from './execution/resources.js'

/** Parse at this boundary too, since tests and internal dispatch can bypass transport parsing. */
const handlers: Record<string, CommandHandler> = {
  'workflow.validate': (p) =>
    validateWorkflow(
      workflowCommands['workflow.validate'].params.parse(p).definition,
    ),
  'workflow.list': (p, { store }) => ({
    versions: store.workflows.list(
      workflowCommands['workflow.list'].params.parse(p).projectId,
    ),
  }),
  'workflow.get': (p, { store }) => {
    const input = workflowCommands['workflow.get'].params.parse(p)
    return {
      version: store.workflows.get(
        input.projectId,
        input.definitionId,
        input.revision,
      ),
    }
  },
  'workflow.save': (p, { store }) => {
    const input = workflowCommands['workflow.save'].params.parse(p)
    const replay = store.workflowRuns.requestResult(
      input.requestId,
      'workflow.save',
      workflowHash({ ...input, id: input.definitionId, origin: 'manual' }),
    )
    if (replay) return replay as Record<string, unknown>
    return {
      version: saveWorkflowDefinition(store, {
        ...input,
        id: input.definitionId,
        origin: 'manual',
      }),
    }
  },
  'workflow.archive': (p, { store }) => {
    const input = workflowCommands['workflow.archive'].params.parse(p)
    return store.transaction(() => {
      const hash = workflowHash(input)
      const replay = store.workflowRuns.requestResult(
        input.requestId,
        'workflow.archive',
        hash,
      )
      if (replay) return replay as Record<string, unknown>
      if (store.workflowRuns.hasActiveDefinition(input.definitionId))
        throw new CommandError('invalid_state', 'Workflow 正在运行，不能归档')
      const result = {
        archived: store.workflows.archive(
          input.projectId,
          input.definitionId,
          input.baseRevision,
        ),
      }
      store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.archive',
        hash,
        result,
      )
      return result
    })
  },
  'workflow.run.start': async (p, ctx) => {
    const input = workflowCommands['workflow.run.start'].params.parse(p)
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return { detail: await ctx.workflow.start(input) }
  },
  'workflow.run.get': (p, ctx) => {
    const input = workflowCommands['workflow.run.get'].params.parse(p)
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return { detail: ctx.workflow.get(input.projectId, input.runId) }
  },
  'workflow.run.list': (p, ctx) => {
    const input = workflowCommands['workflow.run.list'].params.parse(p)
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return {
      runs: ctx.workflow.list(input.projectId, input.limit, input.offset),
    }
  },
  'workflow.run.cancel': async (p, ctx) => {
    const input = workflowCommands['workflow.run.cancel'].params.parse(p)
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    const hash = workflowHash(input)
    const replay = ctx.store.workflowRuns.requestResult(
      input.requestId,
      'workflow.run.cancel',
      hash,
    )
    if (replay) return replay as Record<string, unknown>
    const result = {
      detail: await ctx.workflow.cancel(input.projectId, input.runId),
    }
    // Cancellation is inherently idempotent, including across the commit/response crash window.
    if (
      !ctx.store.workflowRuns.requestResult(
        input.requestId,
        'workflow.run.cancel',
        hash,
      )
    )
      ctx.store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.run.cancel',
        hash,
        result,
      )
    return result
  },
  'workflow.run.resume': async (p, ctx) => {
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return {
      detail: await ctx.workflow.resume(
        workflowCommands['workflow.run.resume'].params.parse(p),
      ),
    }
  },
  'workflow.run.retry_node': async (p, ctx) => {
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return {
      detail: await ctx.workflow.resume(
        workflowCommands['workflow.run.retry_node'].params.parse(p),
      ),
    }
  },
  'workflow.confirm.respond': async (p, ctx) => {
    if (!ctx.workflow)
      throw new CommandError('unsupported', 'Workflow service unavailable')
    return {
      detail: await ctx.workflow.respond(
        workflowCommands['workflow.confirm.respond'].params.parse(p),
      ),
    }
  },
}

export const workflowCommandHandlers: Record<string, CommandHandler> =
  Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (async (p, ctx) => {
        try {
          return await handler(p, ctx)
        } catch (error) {
          if (error instanceof CommandError) throw error
          const code =
            error instanceof Error &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : error instanceof Error &&
                  /^workflow_[a-z_]+$/.test(error.message)
                ? error.message
                : 'invalid_request'
          throw new CommandError(
            code,
            'Workflow 操作失败，请检查配置、状态或校验结果',
          )
        }
      }) satisfies CommandHandler,
    ]),
  )
