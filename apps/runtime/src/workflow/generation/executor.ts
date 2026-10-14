import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import { loadSecret } from '../../secrets.js'
import { randomUUID } from 'node:crypto'
import type { ChatAgent } from '../../agent/index.js'
import type { Store } from '../../store/index.js'
import { resolveSampling } from '../../agent/provider-resolver.js'
import { createPendingAssistantMessage } from '../../agent/launcher.js'
import { RunEventEmitter, type EventNotifier } from '../../events.js'

export interface GenerationModelInput {
  projectId: string
  generationId: string
  providerId: string
  model: string
  profile: ProviderProfile
  systemPrompt: string
  task: string
  maxTokens: number
  signal: AbortSignal
  onUsage: (tokens: number, estimated: boolean) => void
}
export type GenerationModelExecutor = (
  input: GenerationModelInput,
) => Promise<string>

/** Uses the existing ordinary Run lifecycle with an empty ToolRegistry and isolated context. */
export function generationModelExecutor(
  store: Store,
  agent: ChatAgent,
  notify: EventNotifier,
): GenerationModelExecutor {
  return async (input) => {
    if (input.signal.aborted) throw new Error('generation_cancelled')
    const live = store.providers.get(input.providerId)
    if (
      !live?.enabled ||
      !live.capabilities.includes('chat') ||
      live.secretRef !== input.profile.secretRef ||
      !live.models.includes(input.model)
    )
      throw new Error('workflow_configuration_unavailable')
    const apiKey = loadSecret(input.profile.secretRef)
    if (!apiKey) throw new Error('workflow_configuration_unavailable')
    const resolved = { profile: input.profile, apiKey }
    if (
      !resolved.profile.capabilities.includes('chat') ||
      !resolved.profile.models.includes(input.model)
    )
      throw new Error('workflow_configuration_unavailable')
    const setup = store.transaction(() => {
      const generation = store.workflowGenerations.get(
        input.projectId,
        input.generationId,
      )!
      if (generation.status !== 'running')
        throw new Error('generation_cancelled')
      const session = generation.sessionId
        ? store.sessions.get(generation.sessionId)!
        : store.sessions.create(input.projectId, 'Workflow 生成')
      const run = store.runs.create({
        sessionId: session.id,
        providerId: input.providerId,
        model: input.model,
        agentId: randomUUID(),
      })
      store.workflowGenerations.update({
        ...generation,
        sessionId: session.id,
        runIds: [...generation.runIds, run.id],
        updatedAt: new Date().toISOString(),
      })
      store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'user',
        content: input.task,
        status: 'completed',
      })
      return {
        session,
        run,
        assistant: createPendingAssistantMessage(store, session.id, run),
      }
    })
    const settings = store.agentSettings.get()
    return new Promise((resolve, reject) => {
      let reported = false
      const fail = (error: Error) => {
        if (!reported) input.onUsage(input.maxTokens, true)
        reject(error)
      }
      try {
        agent.workflow.launch({
          run: setup.run,
          session: setup.session,
          profile: resolved.profile,
          apiKey: resolved.apiKey,
          model: input.model,
          sampling: {
            ...resolveSampling(resolved.profile),
            maxTokens: Math.min(
              16000,
              input.maxTokens,
              resolved.profile.maxTokens ?? Infinity,
            ),
          },
          skill: null,
          systemPrompt: input.systemPrompt,
          assistantMessage: setup.assistant,
          emitter: new RunEventEmitter(setup.run.id, notify),
          allowedTools: new Set(),
          onToolBatch: () => {
            throw new Error('generation_tools_disabled')
          },
          beforeToolInvoke: () => {
            throw new Error('generation_tools_disabled')
          },
          isolatedContext: true,
          parentSignal: input.signal,
          permissionPreset: 'workspace-read',
          approvalOverride: 'ask-everything',
          runSettings: {
            ...settings,
            maxRunTotalTokens: input.maxTokens,
            maxToolCalls: 1,
            maxRunTimeoutSec: 120,
          },
          onModelResult: (usage, estimated) => {
            reported = true
            input.onUsage(
              usage.promptTokens + usage.completionTokens,
              estimated === true,
            )
          },
          onResult: resolve,
          onFailure: fail,
          onCancel: () => fail(new Error('generation_cancelled')),
        })
      } catch {
        store.runs.finalize(setup.run.id, 'failed', 'generation_launch_failed')
        store.messages.finalize(setup.assistant.id, '', 'failed', '')
        fail(new Error('generation_launch_failed'))
      }
    })
  }
}
