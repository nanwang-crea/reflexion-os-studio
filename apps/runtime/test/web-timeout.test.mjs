import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebFetchTool } from '../dist/agent/tools/web.js'
import { Store } from '../dist/store/index.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunEventEmitter } from '../dist/events.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'

async function server(t, handler) {
  const instance = createServer(handler)
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  t.after(() => {
    instance.closeAllConnections()
    return new Promise((resolve) => instance.close(resolve))
  })
  return `http://127.0.0.1:${instance.address().port}`
}

for (const partial of [false, true]) {
  test(`web timeout returns a tool failure (${partial ? 'body' : 'headers'})`, async (t) => {
    const url = await server(t, (_req, res) => {
      if (partial) res.write('partial body')
    })
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', () => timeout(50))
    const signal = new AbortController().signal
    const result = await createWebFetchTool().execute({ args: { url }, signal })
    assert.equal(result.isError, true)
    assert.equal(result.code, 'web_fetch_error')
    assert.match(result.content, /超过 20 秒/)
    assert.equal(signal.aborted, false)
  })
}

test('explicit Run cancellation still escapes web.fetch', async (t) => {
  const controller = new AbortController()
  const url = await server(t, () => controller.abort())
  await assert.rejects(
    createWebFetchTool().execute({ args: { url }, signal: controller.signal }),
    { name: 'AbortError' },
  )
})

async function runnerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'web-timeout-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const input = {
    run,
    provider: { apiKey: 'unused', model: 'm', maxRetries: 0 },
    buildHistory: async () => [{ role: 'user', content: 'research' }],
    registry: new ToolRegistry(),
    workspaceRoot: null,
    gate: new PermissionGate({
      preset: 'workspace-read',
      hasWorkspace: false,
      approvalOverride: 'default',
      dangerActive: () => false,
    }),
    approvals: new ApprovalGateway(),
    settings: { maxTurns: 4 },
    controller: new AbortController(),
    emitter: new RunEventEmitter(run.id, () => {}),
    firstAssistantMessage: store.messages.create({
      sessionId: session.id,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    }),
  }
  return { store, run, input }
}

test('web timeout is fed back to the model and the Run completes', async (t) => {
  const fixture = await runnerFixture(t)
  const url = await server(t, () => {})
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms) =>
    timeout(ms === 20_000 ? 50 : ms),
  )
  let calls = 0
  let feedback
  const baseUrl = await server(t, async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta =
      calls === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'fetch-1',
                type: 'function',
                function: {
                  name: 'web.fetch',
                  arguments: JSON.stringify({ url }),
                },
              },
            ],
          }
        : { content: '来源超时，标注未核实并继续汇总。' }
    if (calls === 2)
      feedback = body.messages.find((message) => message.role === 'tool')
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  fixture.input.provider.baseUrl = baseUrl
  fixture.input.registry.register(createWebFetchTool())
  await new RunRunner(fixture.store).execute(fixture.input)
  const [toolCall] = fixture.store.toolCalls.listByRun(fixture.run.id)
  assert.equal(toolCall.status, 'failed')
  assert.equal(toolCall.errorCode, 'web_fetch_error')
  assert.match(toolCall.output.content, /抓取失败/)
  assert.equal(calls, 2)
  assert.match(feedback.content, /抓取失败/)
  assert.equal(fixture.input.controller.signal.aborted, false)
  assert.equal(fixture.store.runs.get(fixture.run.id).status, 'completed')
})

for (const cancelled of [false, true]) {
  test(`Runner uses Run signal for cancellation: ${cancelled}`, async (t) => {
    const fixture = await runnerFixture(t)
    let cancellations = 0
    fixture.input.onCancel = () => cancellations++
    fixture.input.buildHistory = async () => {
      if (cancelled) fixture.input.controller.abort()
      throw new DOMException('transport-local abort', 'AbortError')
    }
    await new RunRunner(fixture.store).execute(fixture.input)
    assert.equal(
      fixture.store.runs.get(fixture.run.id).status,
      cancelled ? 'cancelled' : 'failed',
    )
    assert.equal(cancellations, cancelled ? 1 : 0)
  })
}
