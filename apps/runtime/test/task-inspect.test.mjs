import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { createTaskInspectTool } from '../dist/agent/tools/delegation/inspect.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { createAgentInstance } from '../dist/agent/delegation/instance.js'
import { PermissionGate } from '../dist/agent/permissions/presets.js'
import { coerceToolOutput } from '@reflexion-os-studio/contracts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'task-inspect-'))
  let store = new Store(directory)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const project = store.projects.create({ name: 'test', folderPath: directory })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: 'test',
  })
  const context = (current = run) => ({
    store,
    runId: current.id,
    sessionId: current.sessionId,
    projectId: project.id,
    system: null,
    mcp: null,
    workspaceRoot: null,
    skills: {},
  })
  const inspect = (args = {}, current = run) =>
    createTaskInspectTool(context(current)).execute({ args }).data
  const child = (parent = run, root = run) => {
    const childSession = store.sessions.create(project.id)
    const delegation = store.delegations.create({
      sessionId: parent.sessionId,
      parentRunId: parent.id,
      rootRunId: root.id,
      agentId: 'test-agent',
      task: 'collect evidence',
      childSessionId: childSession.id,
    })
    const childRun = store.runs.create({
      sessionId: childSession.id,
      parentRunId: parent.id,
      delegationId: delegation.id,
      providerId: null,
      model: 'test',
    })
    store.delegations.attachChildRun(delegation.id, childRun.id)
    return { delegation, run: childRun, session: childSession }
  }
  return {
    get store() {
      return store
    },
    project,
    session,
    run,
    context,
    inspect,
    child,
    reopen() {
      store.close()
      store = new Store(directory)
    },
  }
}

test('later root turns can discover interrupted nested work and read canonical partial results after restart', (t) => {
  const f = fixture(t)
  const a = f.child()
  const b = f.child(a.run)
  f.store.messages.create({
    sessionId: b.session.id,
    runId: b.run.id,
    role: 'assistant',
    content: 'partial evidence',
    status: 'interrupted',
  })
  const tool = f.store.toolCalls.create({
    runId: b.run.id,
    messageId: null,
    toolName: 'file.read',
    args: { path: 'demo' },
  })
  f.store.toolCalls.finalize(
    tool.id,
    'completed',
    coerceToolOutput('saved evidence'),
  )
  f.store.delegations.update(b.delegation.id, 'cancelled', null, 'stopped')
  f.reopen()
  const later = f.store.runs.create({
    sessionId: f.session.id,
    providerId: null,
    model: 'test',
  })
  const list = f.inspect({}, later)
  assert.deepEqual(
    list.delegations.map((d) => d.id),
    [a.delegation.id, b.delegation.id],
  )
  const trace = f.inspect({ delegationId: b.delegation.id }, later)
  assert.equal(trace.status, 'cancelled')
  assert.equal(trace.entries[0].text, 'partial evidence')
  assert.match(trace.entries[1].text, /saved evidence/)
})

test('child access includes historical trees of the same root conversation but never other sessions', (t) => {
  const f = fixture(t)
  const a = f.child()
  const b = f.child()
  assert.ok(
    f.inspect({}, a.run).delegations.some((d) => d.id === b.delegation.id),
  )
  const later = f.store.runs.create({
    sessionId: f.session.id,
    providerId: null,
    model: 'test',
  })
  const otherTree = f.child(later, later)
  const otherSession = f.store.sessions.create(f.project.id)
  const otherRun = f.store.runs.create({
    sessionId: otherSession.id,
    providerId: null,
    model: 'test',
  })
  const unrelated = f.child(otherRun, otherRun)
  assert.equal(
    f.inspect({ delegationId: otherTree.delegation.id }, a.run).delegationId,
    otherTree.delegation.id,
  )
  assert.throws(
    () => f.inspect({ delegationId: unrelated.delegation.id }),
    /可访问范围/,
  )
  assert.throws(() => f.inspect({ sessionId: f.session.id }, a.run))
})

test('pagination retrieves all long text without exposing reasoning or continuation', (t) => {
  const f = fixture(t)
  const a = f.child()
  const original = '0123456789'.repeat(400)
  f.store.messages.create({
    sessionId: a.session.id,
    runId: a.run.id,
    role: 'system',
    content: 'private instructions',
    status: 'completed',
  })
  const message = f.store.messages.create({
    sessionId: a.session.id,
    runId: a.run.id,
    role: 'assistant',
    content: original,
    status: 'interrupted',
  })
  f.store.messages.finalize(
    message.id,
    original,
    'interrupted',
    'internal reasoning sentinel',
  )
  const first = f.inspect({
    delegationId: a.delegation.id,
    limit: 1,
    textLength: 2000,
  })
  const second = f.inspect({
    delegationId: a.delegation.id,
    limit: 1,
    textLength: 2000,
    textOffset: first.entries[0].nextTextOffset,
  })
  assert.equal(first.entries[0].text + second.entries[0].text, original)
  assert.equal(second.entries[0].nextTextOffset, null)
  assert.equal(first.total, 1)
  assert.equal(
    JSON.stringify(first).includes('internal reasoning sentinel'),
    false,
  )
  assert.equal('reasoning' in first.entries[0], false)
  assert.equal('providerContinuation' in first.entries[0], false)
  assert.throws(() => f.inspect({ limit: 1000 }))
  for (let i = 0; i < 6; i++) f.child()
  const page = f.inspect({ limit: 5 })
  assert.equal(page.delegations.length, 5)
  assert.equal(f.inspect({ offset: page.nextOffset }).delegations.length, 2)
})

test('inspection is read-only, available without delegation capability, and respects template tool ceilings', (t) => {
  const f = fixture(t)
  const registry = createToolRegistry(f.context())
  assert.ok(registry.has('task.inspect'))
  const gate = new PermissionGate({
    preset: 'workspace-read',
    hasWorkspace: false,
    approvalOverride: 'ask-everything',
    executionMode: () => 'plan',
    dangerActive: () => false,
  })
  assert.equal(
    gate.decisionFor({ toolName: 'task.inspect', subject: { kind: 'none' } }),
    'automatic',
  )
  const base = {
    spawn: {},
    inheritedPreset: 'workspace-read',
    inheritedTools: new Set(['task.inspect']),
    permissionDomainId: 'test',
    canDelegateByDepth: false,
  }
  const inherited = createAgentInstance({ ...base, template: null })
  assert.ok(inherited.allowedTools.includes('task.inspect'))
  assert.equal(inherited.canDelegate, false)
  const narrowed = createAgentInstance({
    ...base,
    template: {
      id: 'limited',
      name: 'limited',
      systemPrompt: 'test',
      description: '',
      policy: {
        permissionCeiling: 'workspace-read',
        allowedTools: [],
        canDelegate: false,
      },
    },
  })
  assert.deepEqual(narrowed.allowedTools, [])
  assert.equal(
    createToolRegistry({ ...f.context(), allowedTools: new Set([]) }).has(
      'task.inspect',
    ),
    false,
  )
})
