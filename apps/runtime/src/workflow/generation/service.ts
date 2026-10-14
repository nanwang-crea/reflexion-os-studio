import { resolveModelRuntimeConfig } from '../../agent/provider-resolver.js'
import { randomUUID } from 'node:crypto'
import {
  type WorkflowCommandParams,
  type WorkflowDraft,
  type WorkflowGeneration,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { EmitterRegistry, type EventNotifier } from '../../events.js'
import { workflowHash } from '../execution/resources.js'
import { assertWorkflowDefinitionSafe } from '../security/content.js'
import { runGeneration } from './runner.js'
import { editGeneration } from './editing.js'
import type { GenerationModelExecutor } from './executor.js'

export class WorkflowGenerationService {
  private readonly active = new Map<
    string,
    { projectId: string; controller: AbortController; task: Promise<void> }
  >()
  private readonly emitters: EmitterRegistry
  constructor(
    readonly store: Store,
    private readonly execute: GenerationModelExecutor,
    readonly tools: (projectId: string) => ReadonlySet<string>,
    notify: EventNotifier,
  ) {
    this.emitters = new EmitterRegistry(notify)
  }
  get(projectId: string, id: string): WorkflowGeneration {
    const value = this.store.workflowGenerations.get(projectId, id)
    if (!value) throw new Error('workflow_generation_not_found')
    return value
  }
  private changed(value: WorkflowGeneration): void {
    try {
      this.emitters
        .for({
          scope: 'workflow',
          projectId: value.projectId,
          generationId: value.id,
        })
        .next({
          type: 'workflow.generation.updated',
          stateVersion: value.stateVersion,
          status: value.status,
          updatedAt: value.updatedAt,
        })
    } catch {
      /* Canonical state survives a disconnected renderer. */
    }
  }
  start(input: WorkflowCommandParams<'workflow.generate'>): WorkflowGeneration {
    const hash = workflowHash(input)
    const replay = this.store.workflowRuns.requestResult(
      input.requestId,
      'workflow.generate',
      hash,
    )
    if (replay)
      return this.get(
        input.projectId,
        String((replay as { generationId: string }).generationId),
      )
    const draft = this.store.workflowDrafts.get(input.projectId, input.draftId)
    if (!draft || draft.revision !== input.baseRevision)
      throw new Error('workflow_draft_conflict')
    assertWorkflowDefinitionSafe({
      ...draft.definition,
      description: input.description,
    })
    const profile = this.store.providers.get(input.providerId)
    if (
      !profile?.enabled ||
      !profile.capabilities.includes('chat') ||
      !profile.models.includes(input.model)
    )
      throw new Error('workflow_configuration_unavailable')
    if (
      [...this.active.entries()].some(
        ([id, active]) =>
          active.projectId === input.projectId &&
          this.get(input.projectId, id).draftId === draft.id,
      )
    )
      throw new Error('workflow_generation_active')
    if (this.active.size >= 2) throw new Error('workflow_generation_limit')
    const now = new Date().toISOString()
    const value: WorkflowGeneration = {
      id: randomUUID(),
      stateVersion: 0,
      projectId: input.projectId,
      draftId: draft.id,
      baseRevision: draft.revision,
      mode: input.mode,
      description: input.description,
      providerId: input.providerId,
      model: input.model,
      status: 'running',
      runIds: [],
      sessionId: null,
      candidate: null,
      validation: null,
      tokensUsed: 0,
      tokensEstimated: false,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    }
    this.store.transaction(() => {
      this.store.workflowGenerations.create(value)
      this.store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.generate',
        hash,
        { generationId: value.id },
      )
    })
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('generation_time_budget')),
      120000,
    )
    // Defer work until the active entry exists; no candidate is ever applied here.
    const task = Promise.resolve()
      .then(() =>
        runGeneration(
          {
            store: this.store,
            execute: this.execute,
            tools: this.tools,
            changed: (value) => this.changed(value),
          },
          value,
          draft,
          resolveModelRuntimeConfig(
            profile,
            this.store.providerModels.get(profile.id, input.model),
          ),
          controller.signal,
        ),
      )
      .finally(() => {
        clearTimeout(timer)
        this.active.delete(value.id)
        this.emitters.evict({
          scope: 'workflow',
          projectId: value.projectId,
          generationId: value.id,
        })
      })
    this.active.set(value.id, { projectId: input.projectId, controller, task })
    this.changed(value)
    return value
  }
  async cancel(projectId: string, id: string): Promise<WorkflowGeneration> {
    const value = this.get(projectId, id)
    const active = this.active.get(id)
    if (value.status === 'running') {
      // Abort before waiting, settle usage before terminal state is persisted.
      active?.controller.abort()
      await active?.task
      const current = this.get(projectId, id)
      if (current.status === 'running')
        this.store.workflowGenerations.update({
          ...current,
          status: 'cancelled',
          errorCode: 'generation_cancelled',
          updatedAt: new Date().toISOString(),
        })
    }
    const result = this.get(projectId, id)
    this.changed(result)
    return result
  }
  apply(
    input: WorkflowCommandParams<'workflow.apply_generation'>,
  ): WorkflowDraft {
    return this.store.transaction(() => {
      const hash = workflowHash(input)
      const replay = this.store.workflowRuns.requestResult(
        input.requestId,
        'workflow.apply_generation',
        hash,
      )
      if (replay) return (replay as { draft: WorkflowDraft }).draft
      const value = this.get(input.projectId, input.generationId)
      if (value.stateVersion !== input.stateVersion)
        throw new Error('workflow_generation_state_conflict')
      const draft = this.store.workflowDrafts.get(
        input.projectId,
        value.draftId,
      )
      if (!draft || draft.revision !== value.baseRevision)
        throw new Error('workflow_draft_conflict')
      if (
        value.status !== 'ready' ||
        !value.candidate ||
        !value.validation?.valid
      )
        throw new Error('workflow_generation_invalid')
      const updated: WorkflowDraft = {
        ...draft,
        revision: draft.revision + 1,
        definition: value.candidate,
        generationId: value.id,
        updatedAt: new Date().toISOString(),
      }
      this.store.workflowDrafts.write(updated, draft.revision)
      this.store.workflowGenerations.update({
        ...value,
        status: 'applied',
        updatedAt: new Date().toISOString(),
      })
      this.store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.apply_generation',
        hash,
        { draft: updated },
      )
      return updated
    })
  }
  edit(input: WorkflowCommandParams<'workflow.edit_generation'>) {
    const generation = editGeneration(this, input)
    this.changed(generation)
    return generation
  }
  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort()
    await Promise.all([...this.active.values()].map((value) => value.task))
    this.emitters.clear()
  }
}
