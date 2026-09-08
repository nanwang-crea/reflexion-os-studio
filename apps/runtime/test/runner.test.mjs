import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/runner.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { ApprovalGateway, PermissionGate } from '../dist/agent/permissions.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-runner-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sendSse(response, content) {
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  )
  response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
  response.end('data: [DONE]\n\n')
}

test('runner resets retry draft in order and restarts chunk sequence', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const firstAssistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  let requests = 0
  const server = await startServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests === 1) {
      response.write('data: {"choices":[{"delta":{"content":"o1"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"o2"}}]}\n\n')
      response.end()
      return
    }
    sendSse(response, 'new')
  })
  const events = []
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'key',
        model: 'model',
        maxRetries: 1,
      },
      buildHistory: async () => [{ role: 'user', content: 'hello' }],
      registry: new ToolRegistry(),
      workspaceRoot: null,
      gate: new PermissionGate('workspace', false),
      approvals: new ApprovalGateway(),
      settings: { maxTurns: 1 },
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
      firstAssistantMessage,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const retryingIndex = events.findIndex(
    (event) => event.type === 'run.retrying',
  )
  const resetIndex = events.findIndex((event) => event.type === 'message.reset')
  assert.notEqual(retryingIndex, -1, 'run.retrying must be emitted')
  assert.notEqual(resetIndex, -1, 'message.reset must be emitted')
  assert.equal(retryingIndex + 1, resetIndex)
  assert.equal(events[resetIndex].messageId, firstAssistantMessage.id)
  assert.equal(events[retryingIndex].attempt, 1)
  assert.equal(events[retryingIndex].maxRetries, 1)
  assert.equal(events[retryingIndex].waitMs, 1000)

  const deltas = events.filter((event) => event.type === 'message.delta')
  assert.deepEqual(
    deltas.map((event) => [event.chunkSeq, event.delta]),
    [
      [0, 'o1'],
      [1, 'o2'],
      [0, 'new'],
    ],
  )
  assert.equal(
    store.messages
      .listBySession(session.id)
      .find((message) => message.id === firstAssistantMessage.id).content,
    'new',
  )
})
