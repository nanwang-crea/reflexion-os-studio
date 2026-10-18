import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { Store } from '../dist/store/index.js'
import { BrowserAgentService } from '../dist/browser/agent/service.js'
import { browserWorkerPaths } from '../dist/browser/agent/paths.js'
import { browserTools } from '../dist/agent/tools/browser.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunEventEmitter } from '../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'

process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { PlaywrightBackend } = await import('./fixtures/browser-backend.mjs')

function send(response, delta, finish) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  )
}

test('Agent receives approved rendered browser evidence through canonical ToolOutput and can answer', async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-browser-chat-')),
  )
  store.browserSettings.upsert({
    ...store.browserSettings.get(),
    agentBrowserEnabled: true,
  })
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'fixture',
  })
  const firstAssistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  const pageServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(
      '<title>Research fixture</title><main id="root"></main><script>document.querySelector("#root").innerHTML="<h1>Rendered research fact</h1><p>The fixture count is 42.</p>"</script>',
    )
  })
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve))
  const url = `http://fixture.test:${pageServer.address().port}/`
  const backend = new PlaywrightBackend()
  let identity
  const browser = new BrowserAgentService(store, () => ({
    connect: async () => {},
    disposeAndWait: () => backend.close(),
    callTool: async (name, args) => {
      const document =
        name === 'navigate'
          ? await backend.navigate(args.url, args.from)
          : await backend.read(args)
      identity = document.page
      return JSON.stringify(document)
    },
  }))
  const registry = new ToolRegistry()
  for (const tool of browserTools({
    browser,
    sessionId: session.id,
    runId: run.id,
  }))
    registry.register(tool)
  for (const spec of registry.specs()) {
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.description.length > 0)
  }
  const approvals = new ApprovalGateway()
  const events = []
  const emitter = new RunEventEmitter(run.id, (event) => {
    events.push(event)
    if (event.type === 'approval.required')
      queueMicrotask(() =>
        approvals.resolveChoice(event.toolCallId, 'allow-once'),
      )
  })
  let turn = 0
  let observed = false
  const provider = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const input = JSON.parse(raw)
    ++turn
    if (turn <= 2) {
      send(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${turn}`,
              type: 'function',
              function: {
                name: turn === 1 ? 'browser.navigate' : 'browser.read',
                arguments: JSON.stringify(turn === 1 ? { url } : identity),
              },
            },
          ],
        },
        'tool_calls',
      )
    } else {
      const messages = JSON.stringify(input.messages)
      observed =
        messages.includes('Rendered research fact') &&
        messages.includes('不可信网页资料') &&
        messages.includes(url)
      send(response, { content: '网页的渲染正文给出的数量是 42。' }, 'stop')
    }
  })
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-key',
        model: 'fixture',
        maxRetries: 0,
      },
      buildHistory: async () => [
        { role: 'user', content: '请阅读网页并回答数量。' },
      ],
      registry,
      workspaceRoot: null,
      gate: new PermissionGate({
        preset: 'workspace-read',
        hasWorkspace: false,
        approvalOverride: 'default',
        dangerActive: () => false,
      }),
      approvals,
      settings: { maxTurns: 4 },
      controller: new AbortController(),
      emitter,
      firstAssistantMessage,
    })
    assert.equal(
      observed,
      true,
      'provider must receive rendered evidence only after the read approval',
    )
    assert.equal(store.runs.get(run.id).status, 'completed')
    const existingBrowser = backend.browser
    browser.finishRun(run.id)
    assert.equal(existingBrowser.isConnected(), true)
    const nextRun = store.runs.create({
      sessionId: session.id,
      providerId: 'fixture',
      model: 'fixture',
    })
    const continued = await browser.call(
      session.id,
      nextRun.id,
      'read',
      identity,
      new AbortController().signal,
    )
    assert.match(continued.snapshot, /fixture count is 42/)
    assert.equal(backend.browser, existingBrowser)
    browser.finishRun(nextRun.id)
    const calls = store.toolCalls.listByRun(run.id)
    assert.deepEqual(
      calls.map((call) => call.toolName),
      ['browser.navigate', 'browser.read'],
    )
    assert.equal(calls[0].output.data.snapshot, undefined)
    assert.match(calls[1].output.data.snapshot, /fixture count is 42/)
    assert.equal(calls[1].output.provenance.trust, 'untrusted_external')
    assert.deepEqual(
      events
        .filter((event) => event.type === 'approval.required')
        .map((event) => event.operation),
      ['browser.navigate', 'browser.read'],
    )
  } finally {
    await browser.shutdown()
    await backend.close()
    await new Promise((resolve) => provider.close(resolve))
    await new Promise((resolve) => pageServer.close(resolve))
    store.close()
  }
})

test('navigation completion projects persisted failure and root conversation without creating a page', async () => {
  const { finalizeToolCall, createRunExecutionState } =
    await import('../dist/agent/run/run-state.js')
  const { navigationResult } =
    await import('../dist/agent/run/navigation-result.js')
  const directory = mkdtempSync(join(tmpdir(), 'browser-navigation-notice-'))
  const store = new Store(directory)
  try {
    const rootSession = store.sessions.create(null)
    const childSession = store.sessions.create(null)
    const root = store.runs.create({
      sessionId: rootSession.id,
      providerId: null,
      model: null,
    })
    const child = store.runs.create({
      sessionId: childSession.id,
      providerId: null,
      model: null,
      parentRunId: root.id,
    })
    const call = store.toolCalls.create({
      runId: child.id,
      messageId: null,
      toolName: 'browser.navigate',
      args: { url: 'https://example.com/search?q=test' },
    })
    const events = []
    const emitter = new RunEventEmitter(child.id, (event) => events.push(event))
    const output = {
      type: 'tool_output',
      version: 1,
      content: 'DNS returned a reserved address',
      data: null,
      changedFiles: [],
      resourceLinks: [],
      provenance: null,
    }
    finalizeToolCall(
      store,
      createRunExecutionState(),
      emitter,
      call.id,
      'failed',
      'browser_network_denied',
      output,
    )
    assert.equal(events[0].navigation.rootSessionId, rootSession.id)
    assert.equal(events[0].navigation.sessionId, childSession.id)
    assert.equal(
      events[0].navigation.message,
      store.toolCalls.get(call.id).output.content,
    )
    assert.equal(events[0].navigation.url, call.args.url)
    assert.deepEqual(navigationResult(store, call.id, 'cancelled'), {})
    const other = store.toolCalls.create({
      runId: child.id,
      messageId: null,
      toolName: 'web.fetch',
      args: { url: call.args.url },
    })
    finalizeToolCall(
      store,
      createRunExecutionState(),
      emitter,
      other.id,
      'failed',
      'network_denied',
      output,
    )
    assert.equal(events[1].navigation, undefined)
    finalizeToolCall(
      store,
      createRunExecutionState(),
      emitter,
      call.id,
      'completed',
      null,
      output,
    )
    assert.equal(events[2].navigation.message, '')
    const unsafe = store.toolCalls.create({
      runId: child.id,
      messageId: null,
      toolName: 'browser.navigate',
      args: { url: 'file:///tmp/example' },
    })
    finalizeToolCall(
      store,
      createRunExecutionState(),
      emitter,
      unsafe.id,
      'failed',
      'invalid_request',
      output,
    )
    assert.equal(events[3].navigation, undefined)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
