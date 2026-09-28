import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { ContextBuilder } from '../dist/agent/context/context.js'

test('ContextBuilder.build trims immediately without waiting for checkpoint refresh', async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-ctx-fallback-')),
  )
  const project = store.projects.create({ name: 'p', folderPath: '/w' })
  const session = store.sessions.create(project.id)
  // 大段历史：确保远超极小预算，必然触发压缩路径。
  for (let i = 0; i < 12; i += 1) {
    store.messages.create({
      sessionId: session.id,
      runId: null,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 轮：${'内容'.repeat(400)}`,
      status: 'completed',
    })
  }
  const builder = new ContextBuilder(store)
  const originalFetch = globalThis.fetch
  let requestReceived
  const received = new Promise((resolve) => {
    requestReceived = resolve
  })
  globalThis.fetch = async () => {
    requestReceived()
    return new Promise(() => {})
  }
  const provider = {
    baseUrl: 'http://checkpoint.invalid/v1',
    apiKey: 'k',
    model: 'm',
    contextBudget: 200,
    maxRetries: 0,
    timeoutMs: 5000,
  }
  const controller = new AbortController()
  const messages = await Promise.race([
    builder.build(session.id, '你是助手。', provider, controller.signal),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('build waited for checkpoint refresh')),
        200,
      ),
    ),
  ])
  // 降级产物仍是合法消息序列：system 头 + 确定性裁剪后的最近窗口。
  assert.ok(Array.isArray(messages))
  assert.ok(messages.length > 0)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /助手/)
  await received
  controller.abort()
  globalThis.fetch = originalFetch
  store.close()
})

test('ContextBuilder.build reuses checkpoint and includes watermark suffix', async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-ctx-checkpoint-hit-')),
  )
  const project = store.projects.create({ name: 'p', folderPath: '/w' })
  const session = store.sessions.create(project.id)
  for (let i = 0; i < 16; i += 1) {
    store.messages.create({
      sessionId: session.id,
      runId: null,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息-${i}-${'内容'.repeat(300)}`,
      status: 'completed',
    })
  }
  const messages = store.messages.listBySession(session.id)
  const prefixFrames = messages.slice(0, 8).map((message) => ({
    kind: message.role === 'user' ? 'user' : 'assistant_text',
    content: message.content,
  }))
  const { computeSourceHash } =
    await import('../dist/agent/context/context-checkpoint.js')
  store.contextCheckpoints.upsert({
    sessionId: session.id,
    throughMessageId: messages[7].id,
    sourceHash: computeSourceHash(prefixFrames),
    summary: {
      goal: '复用既有摘要',
      constraints: [],
      decisions: [],
      completed: [],
      pending: [],
      toolFacts: [],
      knownErrors: [],
    },
    tokenEstimate: 10,
    model: 'm',
    schemaVersion: 1,
  })

  const result = await new ContextBuilder(store).build(
    session.id,
    '你是助手。',
    {
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'k',
      model: 'm',
      contextBudget: 5000,
      maxRetries: 0,
    },
    new AbortController().signal,
  )
  const text = result.map((message) => message.content).join('\n')
  assert.match(text, /复用既有摘要/)
  assert.doesNotMatch(text, /消息-0-/)
  assert.match(text, /消息-8-/)
  assert.match(text, /消息-15-/)
  store.close()
})

test('ContextBuilder.buildIsolated injects only child system prompt and task history', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-ctx-isolated-data-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ctx-isolated-work-'))
  writeFileSync(join(workspace, 'AGENTS.md'), 'must-not-enter-child-context')
  const store = new Store(dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  const session = store.sessions.create(project.id)
  store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'user',
    content: 'bounded child task',
    status: 'completed',
  })

  const messages = new ContextBuilder(store).buildIsolated(
    session.id,
    'child-system',
  )

  assert.deepEqual(messages, [
    { role: 'system', content: 'child-system' },
    { role: 'user', content: 'bounded child task' },
  ])
  assert.doesNotMatch(JSON.stringify(messages), /must-not-enter-child-context/)
  store.close()
})
