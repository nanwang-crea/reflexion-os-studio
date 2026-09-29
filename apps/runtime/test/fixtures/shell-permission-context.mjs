import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { Store } from '../../dist/store/index.js'
import { RunEventEmitter } from '../../dist/events.js'
import { createRunExecutionState } from '../../dist/agent/run/run-state.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../../dist/agent/permissions/index.js'

export function freshContext(preset = 'workspace-read', danger = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-shell-rule-')))
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const approvals = new ApprovalGateway()
  const registry = new ToolRegistry()
  const executed = []
  registry.register({
    name: 'shell.execute',
    description: 'test double',
    parameters: { type: 'object' },
    execute: async (input) => {
      executed.push({
        command: input.args.command,
        grant: input.grant,
      })
      return { content: 'ok', isError: false }
    },
  })
  const events = []
  const gate = new PermissionGate({
    preset,
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => danger,
  })
  return {
    store,
    session,
    run,
    approvals,
    registry,
    executed,
    events,
    emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
    input: {
      store,
      state: createRunExecutionState(),
      run,
      gate,
      approvals,
      registry,
      workspaceRoot: '/tmp/p',
      sandboxProvider: 'seatbelt',
      system: {
        request: async (method, params) => {
          assert.equal(method, 'shell.prepare_escalation')
          return {
            escalationRoots: params.escalationRoots,
            sandboxProvider: 'seatbelt',
          }
        },
      },
    },
  }
}

export function shellRequest(id, command, extra = {}) {
  return {
    id,
    name: 'shell.execute',
    arguments: JSON.stringify({ command, ...extra }),
  }
}
