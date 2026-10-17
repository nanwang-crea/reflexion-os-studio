import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChatCompletion } from '../../dist/provider.js'
import { startServer } from '../fixtures/provider-server.mjs'

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
      // 严格 finish reason：mock 流必须携带合法终止原因。
      response.end(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    })
  })
  const port = server.address().port
  await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'previous',
          reasoning: 'previous thought',
          toolCalls: [],
        },
        { role: 'user', content: 'continue' },
      ],
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
  assert.equal(requestBody.messages[1].reasoning_content, 'previous thought')
  assert.deepEqual(requestBody.tools, [
    {
      type: 'function',
      function: {
        name: 'file_read',
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
      tools: [
        { name: 'file.read', description: '', parameters: { type: 'object' } },
        {
          name: 'shell.execute',
          description: '',
          parameters: { type: 'object' },
        },
      ],
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

test('sanitized tool names reverse-map streamed calls and stay within 64 chars', async () => {
  let requestBody = null
  const server = await startServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      requestBody = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"file_read_2","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      )
    })
  })
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      tools: [
        { name: 'file.read', description: '', parameters: { type: 'object' } },
        { name: 'file/read', description: '', parameters: { type: 'object' } },
        {
          name: 'a'.repeat(64),
          description: '',
          parameters: { type: 'object' },
        },
        {
          name: 'a'.repeat(64) + '.',
          description: '',
          parameters: { type: 'object' },
        },
      ],
    },
    () => {},
  )
  server.close()
  assert.deepEqual(
    requestBody.tools.map((tool) => tool.function.name),
    ['file_read', 'file_read_2', 'a'.repeat(64), 'a'.repeat(62) + '_2'],
  )
  assert.equal(result.toolCalls[0].name, 'file/read')
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
      // 严格 finish reason：mock 流必须携带合法终止原因。
      response.end(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    })
  })
  const port = server.address().port
  await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      signal: new AbortController().signal,
      tools: [
        {
          name: 'file.read',
          description: '读取文件',
          parameters: { type: 'object' },
        },
      ],
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
          function: { name: 'file_read', arguments: '{"path":"a.ts"}' },
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

test('chat request returns assistant reasoning_content and omits absent reasoning', async () => {
  const { chatRequestBody } =
    await import('../../dist/provider/openai-chat/projection.js')
  const body = chatRequestBody(
    {
      model: 'thinking-model',
      messages: [
        { role: 'user', content: '检查' },
        {
          role: 'assistant',
          content: '',
          reasoning: '先读取\n再判断',
          toolCalls: [{ id: 'c1', name: 'file.read', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'ok', isError: false },
        {
          role: 'assistant',
          content: '完成',
          reasoning: '已确认',
          toolCalls: [],
        },
        { role: 'assistant', content: '旧消息', toolCalls: [] },
      ],
    },
    new Map(),
  )
  const { OpenAIChatRequestSchema } =
    await import('@reflexion-os-studio/contracts')
  assert.equal(
    OpenAIChatRequestSchema.parse(body).messages[1].reasoning_content,
    '先读取\n再判断',
  )
  assert.equal(body.messages[1].reasoning_content, '先读取\n再判断')
  assert.equal(body.messages[3].reasoning_content, '已确认')
  assert.equal(Object.hasOwn(body.messages[4], 'reasoning_content'), false)
  assert.equal(Object.hasOwn(body.messages[2], 'reasoning_content'), false)
})

test('switching from native thinking to Chat does not replay foreign reasoning or an empty assistant', async () => {
  const { chatRequestBody } =
    await import('../../dist/provider/openai-chat/projection.js')
  const native = {
    apiFormat: 'anthropic',
    baseUrl: 'https://old.invalid',
    model: 'old',
    blocks: [
      { type: 'thinking', thinking: 'foreign thought', signature: 'signature' },
    ],
  }
  const body = chatRequestBody(
    {
      model: 'new',
      messages: [
        { role: 'user', content: 'task' },
        {
          role: 'assistant',
          content: '',
          reasoning: 'foreign thought',
          providerContinuation: native,
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: 'previous answer',
          reasoning: 'foreign thought',
          providerContinuation: native,
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: 'compatible answer',
          reasoning: 'chat thought',
          toolCalls: [],
        },
      ],
    },
    new Map(),
  )
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[1].content, 'previous answer')
  assert.equal(Object.hasOwn(body.messages[1], 'reasoning_content'), false)
  assert.equal(body.messages[2].reasoning_content, 'chat thought')
})

const finishWithToolCalls = (toolCallsLine) =>
  [
    `data: {"choices":[{"delta":{"tool_calls":[${toolCallsLine}]}}]}`,
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

test('missing tool_call ids fall back to index-based unique ids', async () => {
  // 部分聚合/中转服务不回传 tool call id；Run 层按 call.id 建索引，
  // 空 id 会让多个调用互相覆盖，必须兜底为轮次内唯一 id。
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      finishWithToolCalls(
        '{"index":0,"function":{"name":"file.read","arguments":"{}"}},{"index":1,"function":{"name":"shell.execute","arguments":"{}"}}',
      ),
    )
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
  assert.deepEqual(
    result.toolCalls.map((call) => call.id),
    ['index-0', 'index-1'],
  )
})

test('duplicate tool_call ids are deduplicated with suffixes', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      finishWithToolCalls(
        '{"index":0,"id":"call-x","function":{"name":"file.read","arguments":"{}"}},{"index":1,"id":"call-x","function":{"name":"shell.execute","arguments":"{}"}}',
      ),
    )
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
  assert.deepEqual(
    result.toolCalls.map((call) => call.id),
    ['call-x', 'call-x_2'],
  )
})
