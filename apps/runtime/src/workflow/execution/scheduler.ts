import { executeWorkflowNode } from './node-runner.js'
import { nodeInputs, readyNodes } from '../graph/dataflow.js'
import {
  workflowFinalValues,
  workflowDetail,
  createNodeAttempt,
  settleAttempt,
} from './lifecycle.js'
import type { WorkflowServiceDeps } from './deps.js'
import type { WorkflowExecutionContext } from './context.js'

export class WorkflowScheduler {
  constructor(
    private readonly deps: WorkflowServiceDeps,
    private readonly changed: (projectId: string, runId: string) => void,
    private readonly closed: (
      runId: string,
      context: WorkflowExecutionContext,
    ) => void,
  ) {}

  drive(
    projectId: string,
    id: string,
    context: WorkflowExecutionContext,
  ): void {
    if (context.driving || context.closed) return
    context.driving = true
    void this.schedule(projectId, id, context)
      .catch((error) => {
        this.fail(
          id,
          context,
          error instanceof Error ? error.message : 'workflow_failed',
        )
      })
      .finally(() => {
        context.driving = false
        this.finish(projectId, id, context)
      })
  }

  private async schedule(
    projectId: string,
    id: string,
    context: WorkflowExecutionContext,
  ): Promise<void> {
    const { store } = this.deps
    while (!context.closed && !context.controller.signal.aborted) {
      const detail = workflowDetail(store, projectId, id)
      if (detail.run.status !== 'running') return
      const ready = readyNodes(detail)
      let started = false
      for (const node of ready) {
        if (
          node.kind === 'agent' &&
          context.active.size >=
            detail.run.snapshot.definition.budget.maxParallel
        )
          continue
        const reserved = [...context.reservations.values()].reduce(
          (sum, item) => sum + item,
          0,
        )
        const available =
          detail.run.snapshot.definition.budget.maxTokens -
          detail.run.tokensUsed -
          reserved
        if (node.kind === 'agent' && available < 1000) {
          if (context.active.size) continue
          throw new Error('workflow_token_budget')
        }
        const inputs = nodeInputs(workflowDetail(store, projectId, id), node)
        await this.deps.validateResources(
          projectId,
          inputs,
          context.controller.signal,
        )
        if (context.closed || context.controller.signal.aborted) return
        const latest = workflowDetail(store, projectId, id)
        const currentAvailable =
          latest.run.snapshot.definition.budget.maxTokens -
          latest.run.tokensUsed -
          [...context.reservations.values()].reduce(
            (sum, item) => sum + item,
            0,
          )
        if (node.kind === 'agent' && currentAvailable < 1000) {
          if (context.active.size) continue
          throw new Error('workflow_token_budget')
        }
        const attempt = createNodeAttempt(
          store,
          latest,
          node,
          inputs,
          node.kind === 'agent'
            ? Math.min(currentAvailable, node.budget.maxTokens)
            : 0,
        )
        started = true
        if (node.kind === 'confirmation')
          this.armConfirmationTimer(projectId, id, context)
        if (node.kind === 'agent') {
          context.reservations.set(attempt.id, attempt.tokenBudget)
          const task = executeWorkflowNode(
            this.deps,
            this.changed,
            (code) => this.fail(id, context, code),
            projectId,
            id,
            context,
            attempt,
            node,
            inputs,
          ).finally(() => {
            this.advanceClock(id, context)
            context.active.delete(attempt.id)
            context.reservations.delete(attempt.id)
            this.armExecutionTimer(id, context)
            if (!context.driving) this.drive(projectId, id, context)
          })
          context.active.set(attempt.id, task)
          this.armExecutionTimer(id, context)
        }
        this.changed(projectId, id)
        // Refresh counters and readiness after every admitted node.
        break
      }
      if (!started) return
    }
  }

  fail(id: string, context: WorkflowExecutionContext, code: string): void {
    if (context.closed || context.failure || context.controller.signal.aborted)
      return
    context.failure = code
    context.controller.abort(new Error(code))
    const run = this.deps.store.workflowRuns.get(id)!
    if (run.status === 'running' || run.status === 'waiting_user')
      this.deps.store.workflowRuns.update({
        ...run,
        status: 'cancelling',
        errorCode: code,
      })
  }

  private finish(
    projectId: string,
    id: string,
    context: WorkflowExecutionContext,
  ): void {
    if (context.closed) return
    const { store } = this.deps
    const detail = workflowDetail(store, projectId, id)
    if (context.active.size) return
    if (context.controller.signal.aborted) {
      store.transaction(() => {
        for (const confirmation of detail.confirmations)
          if (confirmation.status === 'pending')
            store.workflowConfirmations.resolve(confirmation.id, 'cancelled')
        for (const attempt of detail.attempts)
          settleAttempt(
            store,
            attempt.id,
            'cancelled',
            context.failure ?? 'cancelled',
          )
        const run = store.workflowRuns.get(id)!
        store.workflowRuns.update({
          ...run,
          status: context.failure ? 'failed' : 'cancelled',
          errorCode: context.failure,
        })
      })
      this.close(projectId, id, context)
      return
    }
    if (detail.outputs.length === detail.run.snapshot.definition.nodes.length) {
      try {
        workflowFinalValues(detail.run.snapshot.definition, detail.outputs)
      } catch {
        this.fail(id, context, 'workflow_result_invalid')
        this.finish(projectId, id, context)
        return
      }
      store.workflowRuns.update({
        ...detail.run,
        status: 'succeeded',
        errorCode: null,
      })
      this.close(projectId, id, context)
    } else if (
      detail.confirmations.some(
        (confirmation) => confirmation.status === 'pending',
      )
    ) {
      if (detail.run.status !== 'waiting_user')
        store.workflowRuns.update({ ...detail.run, status: 'waiting_user' })
      this.armConfirmationTimer(projectId, id, context)
      this.changed(projectId, id)
    } else if (detail.run.status === 'running') {
      this.drive(projectId, id, context)
    }
  }

  advanceClock(id: string, context: WorkflowExecutionContext): void {
    if (context.lastActiveAt === null) return
    const now = Date.now()
    const run = this.deps.store.workflowRuns.get(id)!
    this.deps.store.workflowRuns.update({
      ...run,
      executionMs: run.executionMs + Math.max(0, now - context.lastActiveAt),
      activeSince: new Date(now).toISOString(),
    })
    context.lastActiveAt = now
  }
  private armExecutionTimer(
    id: string,
    context: WorkflowExecutionContext,
  ): void {
    clearTimeout(context.timer)
    this.advanceClock(id, context)
    if (!context.active.size) {
      context.lastActiveAt = null
      const run = this.deps.store.workflowRuns.get(id)!
      if (run.activeSince !== null)
        this.deps.store.workflowRuns.update({ ...run, activeSince: null })
      return
    }
    context.lastActiveAt ??= Date.now()
    const current = this.deps.store.workflowRuns.get(id)!
    if (current.activeSince === null)
      this.deps.store.workflowRuns.update({
        ...current,
        activeSince: new Date(context.lastActiveAt).toISOString(),
      })
    const run = this.deps.store.workflowRuns.get(id)!
    const remaining = Math.max(
      0,
      run.snapshot.definition.budget.maxExecutionSec * 1000 - run.executionMs,
    )
    context.timer = setTimeout(() => {
      this.advanceClock(id, context)
      this.fail(id, context, 'workflow_time_budget')
    }, remaining)
  }
  armConfirmationTimer(
    projectId: string,
    id: string,
    context: WorkflowExecutionContext,
  ): void {
    clearTimeout(context.confirmationTimer)
    const pending = this.deps.store.workflowConfirmations
      .list(id)
      .filter((item) => item.status === 'pending')
    if (!pending.length) return
    const nearest = Math.min(
      ...pending.map((item) => Date.parse(item.expiresAt)),
    )
    context.confirmationTimer = setTimeout(
      () => {
        for (const item of pending)
          if (
            Date.parse(item.expiresAt) <= Date.now() &&
            this.deps.store.workflowConfirmations.get(item.id)?.status ===
              'pending'
          )
            this.deps.store.workflowConfirmations.resolve(item.id, 'expired')
        this.fail(id, context, 'workflow_confirmation_expired')
        this.drive(projectId, id, context)
      },
      Math.max(0, nearest - Date.now()),
    )
  }
  private close(
    projectId: string,
    id: string,
    context: WorkflowExecutionContext,
  ): void {
    context.closed = true
    context.clearTimers()
    this.changed(projectId, id)
    this.closed(id, context)
    context.finish()
  }
}
