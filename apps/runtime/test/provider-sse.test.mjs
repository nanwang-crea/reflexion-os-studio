import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { ProviderError, streamChatCompletion } from '../dist/provider.js'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sseBody() {
  const lines = [
    'data: {"choices":[{"delta":{"content":"He"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ]
  return lines.join('\n')
}

test('streamChatCompletion collects deltas, finish reason and usage', async () => {
  const server = await startServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.match(request.headers.authorization ?? '', /^Bearer sk-/)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sseBody())
  })
  const port = server.address().port
  const deltas = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    },
    (delta) => deltas.push(delta),
  )
  server.close()

  assert.deepEqual(deltas, ['He', 'llo'])
  assert.equal(result.content, 'Hello')
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2 })
})

test('maps HTTP status to stable error codes', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"bad key"}')
  })
  const port = server.address().port
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-wrong',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'authentication',
  )
  server.close()
})

test('connection failure maps to network', async () => {
  // 端口 1 几乎必然拒绝连接
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'network',
  )
})

test('user abort propagates as AbortError', async () => {
  const controller = new AbortController()
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    // 保持连接不结束，等待客户端 abort
    request.on('close', () => response.end())
  })
  const port = server.address().port
  const pending = streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    },
    () => {},
  )
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  server.close()
})

test('canonical ToolSpec is projected into OpenAI function tools', async () => {
  let requestBody = null
  const server = await startServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      requestBody = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    })
  })
  const port = server.address().port
  await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      tools: [
        {
          name: 'file.read',
          description: '读取文件',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
    },
    () => {},
  )
  server.close()
  assert.deepEqual(requestBody.tools, [
    {
      type: 'function',
      function: {
        name: 'file.read',
        description: '读取文件',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    },
  ])
})

test('streamChatCompletion accumulates tool_call deltas by index', async () => {
  const lines = [
    // 首片：两路调用各携带 id/name，index 0 附带 arguments 起始。
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"file.read","arguments":"{\\"path\\""}},{"index":1,"id":"call-b","function":{"name":"shell.execute","arguments":""}}]}}]}',
    '',
    // 中片：两路 arguments 继续累积；无 name 分片。
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.ts\\"}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ]
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(lines.join('\n'))
  })
  const port = server.address().port
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    },
    () => {},
  )
  server.close()

  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.toolCalls, [
    { id: 'call-a', name: 'file.read', arguments: '{"path":"a.ts"}' },
    { id: 'call-b', name: 'shell.execute', arguments: '{"command":"ls"}' },
  ])
})

test('canonical ModelMessage projects to OpenAI wire dialect', async () => {
  let requestBody = null
  const server = await startServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      requestBody = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: [DONE]\n\n')
    })
  })
  const port = server.address().port
  await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      signal: new AbortController().signal,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '让我读取',
          toolCalls: [
            { id: 'call-9', name: 'file.read', arguments: '{"path":"a.ts"}' },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-9',
          content: '{"lines":3}',
          isError: false,
        },
      ],
    },
    () => {},
  )
  server.close()
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '让我读取',
      tool_calls: [
        {
          id: 'call-9',
          type: 'function',
          function: { name: 'file.read', arguments: '{"path":"a.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-9', content: '{"lines":3}' },
  ])
})

test('tool_calls finish reason and accumulated calls surface together', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"让我读取文件","tool_calls":[{"index":0,"id":"call-1","function":{"name":"file.read","arguments":"{}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
    '',
    'data: [DONE]',
    '',
  ]
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(lines.join('\n'))
  })
  const port = server.address().port
  const deltas = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    },
    (delta) => deltas.push(delta),
  )
  server.close()
  assert.deepEqual(deltas, ['让我读取文件'])
  assert.equal(result.content, '让我读取文件')
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.usage, { promptTokens: 5, completionTokens: 1 })
})
