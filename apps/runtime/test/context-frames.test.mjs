import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/runner.js'
import {
  FrameError,
  ToolRegistry,
  validateModelMessages,
} from '@reflexion-os-studio/agent-core'
import { ApprovalGateway, PermissionGate } from '../dist/agent/permissions.js'
import {
  framesToValidatedMessages,
  reconstructSessionFrames,
} from '../dist/agent/context-frames.js'
import { createServer } from 'node:http'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-frames-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('reconstruction keeps multi-tool round atomic including failed calls', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const user = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '读两个文件',
    status: 'completed',
  })
  void user
  const assistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '读取中',
    status: 'completed',
  })
  const ok = store.toolCalls.create({
    runId: run.id,
    messageId: assistant.id,
    toolName: 'file.read',
    args: { path: 'a.ts' },
    status: 'running',
  })
  const bad = store.toolCalls.create({
    runId: run.id,
    messageId: assistant.id,
    toolName: 'file.read',
    args: { path: 'b.ts' },
    status: 'running',
  })
  store.toolCalls.finalize(ok.id, 'completed', { content: 'aaa' })
  store.toolCalls.finalize(bad.id, 'failed', undefined, 'file_not_found')
  store.messages.finalize(assistant.id, '读取中', 'completed', '')

  const frames = reconstructSessionFrames(store, session.id, 'sys')
  assert.deepEqual(
    frames.map((f) => f.kind),
    ['system', 'user', 'tool_round'],
  )
  const round = frames[2]
  assert.equal(round.assistant.toolCalls.length, 2)
  assert.equal(round.results.length, 2)
  // 失败调用也有 error result（历史可重放）。
  assert.equal(round.results[1].isError, true)
  assert.match(round.results[1].content, /file_not_found/)
  // 投影后序列合法。
  assert.deepEqual(validateModelMessages(framesToMessagesOf(frames)), [])
})

test('reconstruction skips streaming/pending drafts and superseded messages', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: 'q',
    status: 'completed',
  })
  // streaming 草稿：不回放。
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '写到一半',
    status: 'streaming',
  })
  // superseded：不回放。
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '旧回复',
    status: 'completed',
  })
  store.messages.markSupersededByRun(run.id)

  const frames = reconstructSessionFrames(store, session.id, 'sys')
  assert.deepEqual(
    frames.map((f) => f.kind),
    ['system', 'user'],
  )
})

test('framesToValidatedMessages rejects dangling tool results with FrameError', () => {
  assert.throws(
    () =>
      framesToValidatedMessages([
        { kind: 'system', content: 'sys' },
        { kind: 'user', content: 'hi' },
        {
          kind: 'tool_round',
          assistant: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
          },
          results: [],
        },
      ]),
    FrameError,
  )
})

test('corrupted canonical data fails the run as internal before any provider request', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const firstAssistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })

  let requests = 0
  const server = await startServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'k',
        model: 'm',
        maxRetries: 0,
      },
      // 模拟 ContextBuilder 重建路径遇到损坏数据：FrameError 在请求前抛出。
      buildHistory: async () => {
        throw new FrameError('tool call declared without any result: c1')
      },
      registry: new ToolRegistry(),
      workspaceRoot: null,
      gate: new PermissionGate('workspace', false),
      approvals: new ApprovalGateway(),
      settings: { maxTurns: 2 },
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, () => {}),
      firstAssistantMessage: firstAssistant,
    })
  } finally {
    server.close()
  }
  assert.equal(
    requests,
    0,
    'no provider request must be made with corrupted data',
  )
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'internal')
  // 预建草稿被 Finalizer 收敛为 failed（重读而非旧引用）。
  assert.equal(
    store.messages
      .listBySession(session.id)
      .find((m) => m.id === firstAssistant.id).status,
    'failed',
  )
})

function framesToMessagesOf(frames) {
  const messages = []
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
        messages.push({ role: 'system', content: frame.content })
        break
      case 'user':
        messages.push({ role: 'user', content: frame.content })
        break
      case 'assistant_text':
        messages.push({
          role: 'assistant',
          content: frame.content,
          toolCalls: [],
        })
        break
      case 'tool_round':
        messages.push(frame.assistant)
        messages.push(...frame.results)
        break
      case 'runtime_control':
        messages.push({ role: 'user', content: frame.content })
        break
    }
  }
  return messages
}
