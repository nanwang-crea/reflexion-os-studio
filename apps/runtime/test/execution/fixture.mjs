import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../dist/store/index.js'
import { RunEventEmitter } from '../../dist/events.js'
import { createRunExecutionState } from '../../dist/agent/run/run-state.js'
import {
  PermissionGate,
  ApprovalGateway,
} from '../../dist/agent/permissions/index.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { RunMetrics } from '../../dist/agent/run/performance/metrics.js'

export function fixture(t, preset = 'workspace-write', override = 'default') {
  const dir = mkdtempSync(join(tmpdir(), 'agent-execution-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const project = store.projects.create({ name: 'p', folderPath: dir })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  const state = createRunExecutionState()
  state.lastAssistantMessageId = message.id
  state.currentTurnId = store.turnExecutions.create({
    runId: run.id,
    attempt: 1,
  }).id
  state.metrics = new RunMetrics(null, (value) =>
    store.runs.setPerformance(run.id, value),
  )
  const events = []
  return {
    store,
    state,
    run,
    message,
    events,
    registry: new ToolRegistry(),
    emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
    gate: new PermissionGate({
      preset,
      hasWorkspace: true,
      approvalOverride: override,
      dangerActive: () => false,
    }),
    approvals: new ApprovalGateway(),
    workspaceRoot: dir,
    sandboxProvider: null,
    permissionDomainId: session.id,
    rootRunId: run.id,
  }
}
export const tick = () => new Promise((resolve) => setImmediate(resolve))
export function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
export const request = (id, name, args) => ({
  id,
  name,
  arguments: JSON.stringify(args),
})
