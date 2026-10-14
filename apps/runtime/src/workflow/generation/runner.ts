import type {
  WorkflowDraft,
  WorkflowGeneration,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { GenerationModelExecutor } from './executor.js'
import {
  workflowGenerationTask,
  workflowGenerationPrompt,
} from '../../agent/prompts/workflow-generation.js'
import { generationCandidate } from './candidate.js'

const MAX_TOKENS = 32000
export async function runGeneration(
  deps: {
    store: Store
    execute: GenerationModelExecutor
    tools: (projectId: string) => ReadonlySet<string>
    changed: (value: WorkflowGeneration) => void
  },
  initial: WorkflowGeneration,
  draft: WorkflowDraft,
  profile: ProviderProfile,
  signal: AbortSignal,
): Promise<void> {
  const get = (projectId: string, id: string) => {
    const value = deps.store.workflowGenerations.get(projectId, id)
    if (!value) throw new Error('workflow_generation_not_found')
    return value
  }

  const tools = deps.tools(initial.projectId)
  const original = workflowGenerationTask(draft, initial, [...tools])
  let task = original
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = get(initial.projectId, initial.id)
      if (signal.aborted || value.status !== 'running') return
      const remaining = MAX_TOKENS - value.tokensUsed
      if (remaining < 1000) throw new Error('generation_token_budget')
      const content = await deps.execute({
        projectId: value.projectId,
        generationId: value.id,
        providerId: value.providerId,
        model: value.model,
        profile,
        task,
        systemPrompt: workflowGenerationPrompt(value.mode),
        maxTokens: remaining,
        signal,
        onUsage: (tokens, estimated) => {
          const current = get(value.projectId, value.id)
          if (current.status !== 'running') return
          deps.store.workflowGenerations.update({
            ...current,
            tokensUsed: current.tokensUsed + tokens,
            tokensEstimated: current.tokensEstimated || estimated,
            updatedAt: new Date().toISOString(),
          })
          deps.changed(get(value.projectId, value.id))
        },
      })
      const current = get(value.projectId, value.id)
      if (signal.aborted || current.status !== 'running') return
      if (current.tokensUsed > MAX_TOKENS)
        throw new Error('generation_token_budget')
      let errorCode = 'generation_schema_invalid'
      try {
        const candidate = generationCandidate(
          deps.store,
          draft,
          current.mode,
          content,
          tools,
        )
        deps.store.workflowGenerations.update({
          ...current,
          candidate: candidate.definition,
          validation: candidate.validation,
          status: candidate.validation.valid
            ? 'ready'
            : attempt === 2
              ? 'invalid'
              : 'running',
          errorCode: candidate.validation.valid
            ? null
            : 'generation_graph_invalid',
          updatedAt: new Date().toISOString(),
        })
        if (candidate.validation.valid) {
          deps.changed(get(value.projectId, value.id))
          return
        }
        errorCode = candidate.validation.issues
          .map((issue) => issue.code)
          .join(',')
          .slice(0, 1500)
      } catch {
        /* No raw invalid response or credentials are stored in candidate metadata. */
      }
      task = JSON.stringify({
        request: JSON.parse(original),
        validationErrors: errorCode,
        instruction:
          'Return a corrected candidate from scratch using the original request and schema.',
      })
    }
    const current = get(initial.projectId, initial.id)
    if (current.status === 'running')
      deps.store.workflowGenerations.update({
        ...current,
        status: 'invalid',
        errorCode: 'generation_validation_failed',
        updatedAt: new Date().toISOString(),
      })
  } catch {
    const current = deps.store.workflowGenerations.get(
      initial.projectId,
      initial.id,
    )
    if (current?.status === 'running')
      deps.store.workflowGenerations.update({
        ...current,
        status:
          signal.aborted && signal.reason?.message !== 'generation_time_budget'
            ? 'cancelled'
            : 'failed',
        errorCode:
          signal.reason?.message === 'generation_time_budget'
            ? 'generation_time_budget'
            : signal.aborted
              ? 'generation_cancelled'
              : 'generation_failed',
        updatedAt: new Date().toISOString(),
      })
  }
  const result = deps.store.workflowGenerations.get(
    initial.projectId,
    initial.id,
  )
  if (result) deps.changed(result)
}
