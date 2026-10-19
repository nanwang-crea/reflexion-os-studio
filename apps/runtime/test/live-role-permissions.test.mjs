import { createServer } from 'node:http'
import { once } from 'node:events'
import { RunRunner } from '../dist/agent/run/runner.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './fixtures/skill-packages.mjs'
import { RunLauncher } from '../dist/agent/launcher.js'
import { createChildRunStarter } from '../dist/agent/delegation/starter.js'
import { ApprovalGateway } from '../dist/agent/permissions/index.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'

const role = (patch = {}) => ({
  name: 'Live researcher',
  description: 'Research',
  systemPrompt: 'Research safely.',
  enabled: true,
  allowedTools: ['web.fetch'],
  canDelegate: false,
  permissionCeiling: 'workspace-read',
  projectId: null,
  ...patch,
})

function runningFixture(t, initial = {}) {
  const f = fixture(t)
  f.store.agentSettings.upsert({
    ...f.store.agentSettings.get(),
    enableChildRuns: true,
    maxDepth: 4,
  })
  const session = f.store.sessions.create(f.project.id)
  const parent = f.store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  f.store.browserSettings.upsert({
    ...f.store.browserSettings.get(),
    agentBrowserApproval: 'ask',
  })
  const template = f.store.agents.saveUser(role(initial))
  const inputs = []
  const finishes = []
  let calls = 0
  const browser = {
    finishRun: () => {},
    enabled: true,
    call: async () => {
      calls++
      return { sourceUrl: 'https://example.com' }
    },
  }
  const launcher = new RunLauncher(
    {
      store: f.store,
      system: { available: true, sandboxName: 'test' },
      mcp: null,
      browser,
      skills: f.service.registry,
      approvals: new ApprovalGateway(),
      danger: { isActive: () => false },
      interactions: {},
      runner: {
        execute: (input) =>
          new Promise((resolve) => {
            inputs.push(input)
            finishes.push(() => {
              input.onResult('done')
              resolve()
            })
          }),
      },
    },
    { onRunSettled: () => {} },
  )
  const starter = createChildRunStarter(
    {
      store: f.store,
      skills: f.service.registry,
      notifier: () => {},
      launcher,
      profile: { id: 'p', models: ['m'] },
      apiKey: 'unused',
      model: 'm',
      sampling: {},
      permissionPreset: 'workspace-full',
      inheritedTools: new Set([
        'web.fetch',
        'get_current_time',
        'browser.navigate',
        'browser.read',
        'file.read',
        'file.write',
        'task',
      ]),
    },
    parent,
    session,
  )
  const pending = starter({
    task: 'research',
    agent: { templateId: template.id },
    signal: new AbortController().signal,
  })
  pending.catch(() => {})
  return {
    ...f,
    template,
    inputs,
    browser,
    pending,
    calls: () => calls,
    save: (patch) =>
      f.store.agents.saveUser(role({ ...initial, id: template.id, ...patch })),
    finish: () =>
      finishes
        .splice(0)
        .reverse()
        .forEach((finish) => finish()),
  }
}

test('saving tool permissions and browser enablement updates the same active Run', async (t) => {
  const f = runningFixture(t)
  try {
    const input = f.inputs[0]
    const runId = input.run.id
    assert.equal(input.registry.has('browser.navigate'), false)
    f.save({
      allowedTools: ['web.fetch', 'browser.navigate', 'browser.read'],
      permissionCeiling: 'workspace-full',
    })
    assert.equal(input.registry.has('browser.navigate'), true)
    assert.equal(input.gate.preset, 'workspace-full')
    assert.ok(
      input.registry.specs().some((tool) => tool.name === 'browser.navigate'),
    )
    const request = {
      id: 'nav',
      name: 'browser.navigate',
      arguments: '{"url":"https://example.com"}',
    }
    assert.equal(
      (await input.registry.call(request, input.controller.signal)).isError,
      false,
    )
    assert.equal(f.calls(), 1)
    f.browser.enabled = false
    assert.equal(input.registry.has('browser.navigate'), false)
    f.browser.enabled = true
    assert.equal(input.registry.has('browser.navigate'), true)
    f.save({ allowedTools: ['web.fetch'] })
    assert.equal(
      (await input.registry.call(request, input.controller.signal)).code,
      'unsupported',
    )
    assert.equal(f.calls(), 1)
    assert.equal(input.gate.preset, 'workspace-read')
    assert.equal(input.run.id, runId)
    f.store.agents.removeUser(f.template.id)
    assert.equal(input.registry.specs().length, 0)
    // Historical execution snapshots remain a record of launch-time permissions.
    assert.ok(
      !f.store.delegations
        .listByParentRun(input.run.parentRunId)[0]
        .execution.allowedTools.includes('browser.navigate'),
    )
  } finally {
    f.finish()
    await f.pending
  }
})

test('live delegation switch and ancestor policy changes constrain existing descendants', async (t) => {
  const f = runningFixture(t)
  let task
  try {
    const parent = f.inputs[0]
    assert.equal(parent.registry.has('task'), false)
    f.save({
      allowedTools: ['web.fetch', 'browser.navigate', 'task', 'shell.execute'],
      canDelegate: true,
      permissionCeiling: 'workspace-full',
    })
    assert.equal(parent.registry.has('task'), true)
    assert.equal(
      parent.registry.has('shell.execute'),
      false,
      'cannot exceed root tool boundary',
    )
    task = parent.registry.call(
      { id: 'child', name: 'task', arguments: '{"task":"nested research"}' },
      parent.controller.signal,
    )
    task.catch(() => {})
    const child = f.inputs[1]
    assert.ok(child)
    assert.equal(child.registry.has('browser.navigate'), true)
    assert.equal(child.gate.preset, 'workspace-full')
    f.save({ allowedTools: ['web.fetch'], permissionCeiling: 'workspace-read' })
    assert.equal(parent.registry.has('task'), false)
    assert.equal(child.registry.has('browser.navigate'), false)
    assert.equal(child.gate.preset, 'workspace-read')
    f.store.agents.setEnabled(f.template.id, false)
    assert.equal(parent.registry.specs().length, 0)
    assert.equal(child.registry.specs().length, 0)
  } finally {
    f.finish()
    if (task) await task
    await f.pending
  }
})

for (const change of ['remove-tool', 'lower-preset']) {
  test(`an approval cannot execute stale permissions after ${change}`, async (t) => {
    const f = runningFixture(t, {
      allowedTools: ['browser.navigate'],
      permissionCeiling: 'workspace-full',
    })
    try {
      const input = f.inputs[0]
      const state = {
        lastAssistantMessageId: input.firstAssistantMessage.id,
        toolCallRowIds: new Set(),
        precreatedToolCallRows: new Map(),
        currentTurnId: null,
      }
      let approved = false
      const approvals = new ApprovalGateway()
      t.mock.method(approvals, 'request', async () => {
        approved = true
        f.save(
          change === 'remove-tool'
            ? { allowedTools: [], permissionCeiling: 'workspace-full' }
            : {
                allowedTools: ['browser.navigate'],
                permissionCeiling: 'workspace-read',
              },
        )
        return {
          decision: 'approved',
          choiceId: 'allow-once',
          grantScope: 'once',
          effect: { kind: 'once' },
        }
      })
      const result = await executeToolCall(
        {
          ...input,
          store: f.store,
          state,
          approvals,
          sandboxProvider: null,
          permissionDomainId: input.run.sessionId,
          rootRunId: input.run.id,
        },
        {
          id: 'nav',
          name: 'browser.navigate',
          arguments: '{"url":"https://example.com"}',
        },
        input.controller.signal,
      )
      assert.equal(approved, true)
      assert.equal(result.isError, true)
      assert.equal(
        result.code,
        change === 'remove-tool' ? 'unsupported' : 'permission_changed',
      )
      assert.equal(f.calls(), 0)
      assert.equal(
        f.store.toolCalls.listByRun(input.run.id)[0].status,
        'failed',
      )
    } finally {
      f.finish()
      await f.pending
    }
  })
}

test('revoking a tool while it waits for the mutation lane blocks invocation', async (t) => {
  const f = runningFixture(t, {
    allowedTools: ['file.write'],
    permissionCeiling: 'workspace-full',
  })
  try {
    const input = f.inputs[0]
    const result = await executeToolCall(
      {
        ...input,
        store: f.store,
        state: {
          lastAssistantMessageId: input.firstAssistantMessage.id,
          toolCallRowIds: new Set(),
          precreatedToolCallRows: new Map(),
          currentTurnId: null,
        },
        sandboxProvider: null,
        permissionDomainId: input.run.sessionId,
        rootRunId: input.run.id,
        mutationCoordinator: {
          run: async (invoke) => {
            f.save({ allowedTools: [], permissionCeiling: 'workspace-full' })
            return invoke()
          },
        },
      },
      {
        id: 'write',
        name: 'file.write',
        arguments: '{"path":"report.md","content":"report"}',
      },
      input.controller.signal,
    )
    assert.equal(result.isError, true)
    assert.equal(result.code, 'unsupported')
    assert.equal(f.store.toolCalls.listByRun(input.run.id)[0].status, 'failed')
  } finally {
    f.finish()
    await f.pending
  }
})

test('the next Provider request in the same Run contains newly granted tools', async (t) => {
  const f = runningFixture(t, { allowedTools: ['get_current_time'] })
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push(JSON.parse(raw))
    const first = requests.length === 1
    if (first)
      f.save({
        allowedTools: ['get_current_time', 'browser.navigate', 'browser.read'],
      })
    const delta = first
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'clock',
              function: { name: 'get_current_time', arguments: '{}' },
            },
          ],
        }
      : { content: 'continued with updated tools' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  try {
    const input = f.inputs[0]
    await new RunRunner(f.store).execute({
      ...input,
      provider: {
        ...input.provider,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        maxRetries: 0,
      },
      buildHistory: async () => [{ role: 'user', content: 'research' }],
    })
    assert.equal(requests.length, 2)
    const names = (body) => body.tools.map((tool) => tool.function.name)
    assert.ok(!names(requests[0]).includes('browser_navigate'))
    assert.ok(names(requests[1]).includes('browser_navigate'))
    assert.ok(names(requests[1]).includes('browser_read'))
    assert.equal(f.store.runs.get(input.run.id).status, 'completed')
  } finally {
    f.finish()
    await f.pending
  }
})
