import { workflowCommands } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../../command-utils.js'
import { assertWorkflowDefinitionSafe } from '../security/content.js'
import { workflowHash } from '../execution/resources.js'
import { CommandError } from '../../agent/errors.js'

export const workflowAuthoringHandlers: Record<string, CommandHandler> = {
  'workflow.edit_generation': (p, ctx) => {
    if (!ctx.workflowGeneration)
      throw new CommandError('unsupported', 'Generation service unavailable')
    return {
      generation: ctx.workflowGeneration.edit(
        workflowCommands['workflow.edit_generation'].params.parse(p),
      ),
    }
  },
  'workflow.generations.list': (p, { store }) => {
    const input = workflowCommands['workflow.generations.list'].params.parse(p)
    return {
      generations: store.workflowGenerations.list(
        input.projectId,
        input.draftId,
      ),
    }
  },
  'workflow.draft.list': (p, { store }) => ({
    drafts: store.workflowDrafts.list(
      workflowCommands['workflow.draft.list'].params.parse(p).projectId,
    ),
  }),
  'workflow.draft.save': (p, { store }) => {
    const input = workflowCommands['workflow.draft.save'].params.parse(p)
    return store.transaction(() => {
      const hash = workflowHash(input)
      const replay = store.workflowRuns.requestResult(
        input.requestId,
        'workflow.draft.save',
        hash,
      )
      if (replay) return replay as Record<string, unknown>
      assertWorkflowDefinitionSafe(input.definition)
      if (
        input.definitionId &&
        !store.workflows.get(
          input.projectId,
          input.definitionId,
          input.baseVersion,
        )
      )
        throw new Error('workflow_definition_unavailable')
      if (!input.definitionId && input.baseVersion !== 0)
        throw new Error('workflow_draft_conflict')
      const result = { draft: store.workflowDrafts.save(input) }
      store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.draft.save',
        hash,
        result,
      )
      return result
    })
  },
  'workflow.generate': (p, ctx) => {
    if (!ctx.workflowGeneration)
      throw new CommandError('unsupported', 'Generation service unavailable')
    return {
      generation: ctx.workflowGeneration.start(
        workflowCommands['workflow.generate'].params.parse(p),
      ),
    }
  },
  'workflow.get_generation': (p, ctx) => {
    if (!ctx.workflowGeneration)
      throw new CommandError('unsupported', 'Generation service unavailable')
    const input = workflowCommands['workflow.get_generation'].params.parse(p)
    return {
      generation: ctx.workflowGeneration.get(
        input.projectId,
        input.generationId,
      ),
    }
  },
  'workflow.cancel_generation': async (p, ctx) => {
    if (!ctx.workflowGeneration)
      throw new CommandError('unsupported', 'Generation service unavailable')
    const input = workflowCommands['workflow.cancel_generation'].params.parse(p)
    return {
      generation: await ctx.workflowGeneration.cancel(
        input.projectId,
        input.generationId,
      ),
    }
  },
  'workflow.apply_generation': (p, ctx) => {
    if (!ctx.workflowGeneration)
      throw new CommandError('unsupported', 'Generation service unavailable')
    return {
      draft: ctx.workflowGeneration.apply(
        workflowCommands['workflow.apply_generation'].params.parse(p),
      ),
    }
  },
}
