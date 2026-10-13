import {
  WorkflowRunSummarySchema,
  type WorkflowRunSummary,
} from '@reflexion-os-studio/contracts'
import { assertWorkflowValuesSafe } from './security/content.js'
import { resolveModelRuntimeConfig } from '../agent/provider-resolver.js'
import { randomUUID } from 'node:crypto'
import type {
  WorkflowRunDetail,
  WorkflowValues,
  WorkflowExecutionSnapshot,
} from '@reflexion-os-studio/contracts'
import { EmitterRegistry } from '../events.js'
import { validateWorkflow } from './graph/validate.js'
import { validatePortValues } from './graph/ports.js'
import { preflightWorkflow } from './execution/preflight.js'
import { workflowHash } from './execution/resources.js'
import { workflowDetail } from './execution/lifecycle.js'
import { WorkflowExecutionContext } from './execution/context.js'
import { WorkflowScheduler } from './execution/scheduler.js'
import type { WorkflowServiceDeps } from './execution/deps.js'
import { resumeWorkflow } from './recovery/actions.js'
import { respondToWorkflowConfirmation } from './execution/confirmation.js'

export class WorkflowService {
  readonly scheduler: WorkflowScheduler
  private readonly contexts = new Map<string, WorkflowExecutionContext>()
  private readonly emitters: EmitterRegistry

  constructor(readonly deps: WorkflowServiceDeps) {
    this.emitters = new EmitterRegistry(deps.notify)
    this.scheduler = new WorkflowScheduler(
      deps,
      (projectId, id) => this.changed(projectId, id),
      (id, context) => {
        deps.clearPermissionDomain(context.permissionDomainId)
        this.contexts.delete(id)
        this.emitters.evict({
          scope: 'workflow',
          projectId: deps.store.workflowRuns.get(id)!.projectId,
          workflowRunId: id,
        })
      },
    )
  }

  get(projectId: string, id: string): WorkflowRunDetail {
    return workflowDetail(this.deps.store, projectId, id)
  }
  list(projectId: string, limit = 30, offset = 0): WorkflowRunSummary[] {
    return this.deps.store.workflowRuns
      .list(projectId, limit, offset)
      .map((run) =>
        WorkflowRunSummarySchema.parse({
          id: run.id,
          projectId: run.projectId,
          stateVersion: run.stateVersion,
          status: run.status,
          attemptsUsed: run.attemptsUsed,
          tokensUsed: run.tokensUsed,
          tokensEstimated: run.tokensEstimated,
          toolsUsed: run.toolsUsed,
          executionMs: run.executionMs,
          errorCode: run.errorCode,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          definitionId: run.snapshot.definitionId,
          revision: run.snapshot.revision,
          name: run.snapshot.definition.name,
        }),
      )
  }
  changed(projectId: string, id: string): void {
    const run = this.deps.store.workflowRuns.get(id)!
    try {
      this.emitters
        .for({ scope: 'workflow', projectId, workflowRunId: id })
        .next({
          type: 'workflow.run.updated',
          status: run.status,
          stateVersion: run.stateVersion,
        })
    } catch {
      /* A disconnected renderer must not change canonical execution state. */
    }
  }
  activate(projectId: string, id: string): WorkflowExecutionContext {
    if (this.contexts.has(id)) throw new Error('workflow_already_active')
    const context = new WorkflowExecutionContext()
    this.contexts.set(id, context)
    queueMicrotask(() => this.scheduler.drive(projectId, id, context))
    return context
  }
  context(id: string): WorkflowExecutionContext | undefined {
    return this.contexts.get(id)
  }

  async start(input: {
    requestId: string
    projectId: string
    definitionId: string
    revision: number
    inputs: WorkflowValues
    defaultModel: { providerId: string; model: string }
    permissionPreset: WorkflowExecutionSnapshot['permissionPreset']
    approvalOverride: WorkflowExecutionSnapshot['approvalOverride']
  }): Promise<WorkflowRunDetail> {
    const { store } = this.deps
    assertWorkflowValuesSafe(input.inputs)
    const requestHash = workflowHash(input)
    const existing = store.workflowRuns.byRequest(input.requestId)
    if (existing) {
      if (
        existing.requestHash !== requestHash ||
        existing.projectId !== input.projectId
      )
        throw new Error('workflow_request_conflict')
      return this.get(input.projectId, existing.id)
    }
    const version = store.workflows.get(
      input.projectId,
      input.definitionId,
      input.revision,
    )
    if (
      !version ||
      store.workflows.isArchived(input.projectId, input.definitionId)
    )
      throw new Error('workflow_definition_unavailable')
    if (
      !validateWorkflow(version.definition).valid ||
      validatePortValues(version.definition.inputs, input.inputs).length
    )
      throw new Error('workflow_input_invalid')
    const preflight = preflightWorkflow(version.definition, {
      defaultModel: input.defaultModel,
      providers: store.providers.list(),
      availableTools: this.deps.availableTools(input.projectId),
    })
    if (preflight.issues.length)
      throw new Error('workflow_configuration_unavailable')
    await this.deps.validateResources(input.projectId, input.inputs)
    // Another identical start may have completed while resources were being checked.
    const raced = store.workflowRuns.byRequest(input.requestId)
    if (raced) {
      if (raced.requestHash !== requestHash)
        throw new Error('workflow_request_conflict')
      return this.get(input.projectId, raced.id)
    }
    if (
      !store.projects.get(input.projectId) ||
      store.workflows.isArchived(input.projectId, input.definitionId)
    )
      throw new Error('workflow_definition_unavailable')
    const now = new Date().toISOString()
    const run = store.workflowRuns.create({
      id: randomUUID(),
      projectId: input.projectId,
      requestId: input.requestId,
      requestHash,
      stateVersion: 0,
      status: 'running',
      snapshot: {
        version: 1,
        definitionId: input.definitionId,
        revision: input.revision,
        projectId: input.projectId,
        definition: version.definition,
        inputs: input.inputs,
        models: preflight.models.map((model) => ({
          ...model,
          profile: resolveModelRuntimeConfig(
            store.providers.get(model.providerId)!,
            store.providerModels.get(model.providerId, model.model),
          ),
        })),
        permissionPreset: input.permissionPreset,
        approvalOverride: input.approvalOverride,
      },
      attemptsUsed: 0,
      tokensEstimated: false,
      tokensUsed: 0,
      toolsUsed: 0,
      executionMs: 0,
      activeSince: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    })
    this.activate(input.projectId, run.id)
    this.changed(input.projectId, run.id)
    return this.get(input.projectId, run.id)
  }
  async cancel(projectId: string, id: string): Promise<WorkflowRunDetail> {
    const { store } = this.deps
    const detail = this.get(projectId, id)
    if (['succeeded', 'cancelled', 'failed'].includes(detail.run.status))
      return detail
    const context = this.contexts.get(id)
    if (!context) {
      store.transaction(() => {
        for (const item of detail.confirmations)
          if (item.status === 'pending')
            store.workflowConfirmations.resolve(item.id, 'cancelled')
        store.workflowRuns.update({
          ...detail.run,
          status: 'cancelled',
          errorCode: null,
        })
      })
      return this.get(projectId, id)
    }
    this.scheduler.advanceClock(id, context)
    const run = store.workflowRuns.get(id)!
    if (run.status !== 'cancelling')
      store.workflowRuns.update({ ...run, status: 'cancelling' })
    context.controller.abort()
    await Promise.all(context.active.values())
    if (!context.driving) this.scheduler.drive(projectId, id, context)
    await context.settled
    return this.get(projectId, id)
  }
  resume(input: Parameters<typeof resumeWorkflow>[1]) {
    return resumeWorkflow(this, input)
  }
  respond(input: Parameters<typeof respondToWorkflowConfirmation>[1]) {
    return respondToWorkflowConfirmation(this, input)
  }
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.contexts.keys()]
        .filter((id) => !this.contexts.get(id)!.closed)
        .map((id) =>
          this.cancel(this.deps.store.workflowRuns.get(id)!.projectId, id),
        ),
    )
    this.emitters.clear()
  }
}
