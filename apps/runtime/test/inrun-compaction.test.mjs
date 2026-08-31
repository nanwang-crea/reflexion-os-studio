import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { compactInRun } from '../dist/agent/context.js'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** 摘要请求/主请求共用的 SSE 响应体。 */
function sseWith(content) {
  return [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
}

function providerFor(port, extra = {}) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'mock-model',
    ...extra,
  }
}

/** 构造超预算历史:系统 + 若干大消息 + 一对工具轮。 */
function oversizedHistory() {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 30; i += 1) {
    messages.push({
      role: 'user',
      content: `旧问题${i}` + '很多字'.repeat(900),
    })
    messages.push({ role: 'assistant', content: `旧回答${i}`, toolCalls: [] })
  }
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
  })
  messages.push({
    role: 'tool',
    toolCallId: 'c1',
    content: 'x'.repeat(8000),
    isError: false,
  })
  messages.push({ role: 'user', content: '最近一条' })
  return messages
}

test('compactInRun summarizes old rounds when over budget', async () => {
  const bodies = []
  const server = await startServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      bodies.push(JSON.parse(raw))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseWith('这是历史摘要'))
    })
  })
  const port = server.address().port
  const result = await compactInRun(
    oversizedHistory(),
    providerFor(port),
    new AbortController().signal,
  )
  server.close()

  // 摘要请求发生,且压缩 prompt 生效。
  assert.equal(bodies.length, 1)
  assert.match(bodies[0].messages[0].content, /历史|摘要|压缩/i)
  // 结果里出现摘要,旧轮次消失,最近消息保留。
  const text = result.map((m) => m.content).join('\n')
  assert.ok(text.includes('这是历史摘要'))
  assert.ok(!text.includes('旧问题0'))
  assert.ok(text.includes('最近一条'))
  // 无悬空 tool 消息:所有 role=tool 都能匹配到保留的 assistant.toolCalls。
  const keptIds = new Set()
  for (const message of result) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) keptIds.add(call.id)
    }
  }
  for (const message of result) {
    if (message.role === 'tool') {
      assert.equal(keptIds.has(message.toolCallId), true)
    }
  }
})

test('compactInRun falls back to trimming when summarize fails', async () => {
  const server = await startServer((request, response) => {
    // 摘要调用(第 1 次)直接 401:不重试,压缩失败 → 降级裁剪。
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"bad key"}')
  })
  const port = server.address().port
  const result = await compactInRun(
    oversizedHistory(),
    providerFor(port),
    new AbortController().signal,
  )
  server.close()
  // 不抛异常,结果被裁剪到预算内(或至少不再超限)。
  assert.ok(Array.isArray(result))
  assert.equal(result[0].role, 'system')
})

test('compactInRun stays untouched when within budget', async () => {
  let requests = 0
  const server = await startServer((request, response) => {
    requests += 1
    response.writeHead(500)
    response.end()
  })
  const port = server.address().port
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '小事' },
  ]
  const result = await compactInRun(
    messages,
    providerFor(port, { contextBudget: 1_000_000, contextWindow: 4_000_000 }),
    new AbortController().signal,
  )
  server.close()
  assert.equal(requests, 0)
  assert.deepEqual(result, messages)
})
