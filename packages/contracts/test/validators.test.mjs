import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandSchemaRegistry,
  FinishReasonSchema,
  JsonRpcMessageSchema,
  MemorySchema,
  MessageSendParamsSchema,
  MessageStatusSchema,
  MessageSchema,
  ProjectSchema,
  ProviderProfileSchema,
  RunSchema,
  RuntimeErrorSchema,
  RuntimeEventSchema,
  ToolCallSchema,
  ToolSpecSchema,
  jsonSchemas,
} from '../dist/index.js'

const NOW = '2026-08-29T00:00:00.000Z'

test('ProjectSchema accepts a valid project and rejects missing fields', () => {
  const project = {
    id: 'p1',
    name: 'Demo',
    folderPath: '/tmp/demo',
    createdAt: NOW,
    updatedAt: NOW,
  }
  assert.equal(ProjectSchema.safeParse(project).success, true)

  const missingTimestamp = { ...project, createdAt: undefined }
  assert.equal(ProjectSchema.safeParse(missingTimestamp).success, false)

  const badTimestamp = { ...project, updatedAt: 'yesterday' }
  assert.equal(ProjectSchema.safeParse(badTimestamp).success, false)
})

test('MessageSchema enforces role/status enums and canonical parts', () => {
  const base = {
    id: 'm1',
    sessionId: 's1',
    runId: 'r1',
    role: 'user',
    content: 'hello',
    parts: [{ type: 'text', text: 'hello' }],
    reasoning: '',
    status: 'pending',
    createdAt: NOW,
    completedAt: null,
  }
  assert.equal(MessageSchema.safeParse(base).success, true)

  const badStatus = { ...base, status: 'done' }
  assert.equal(MessageSchema.safeParse(badStatus).success, false)
  assert.equal(MessageStatusSchema.safeParse('streaming').success, true)
  assert.equal(MessageStatusSchema.safeParse('complete').success, false)

  // parts 为必填内容块；image 块以 assetId 引用，不接受内联数据。
  assert.equal(MessageSchema.safeParse({ ...base, parts: [] }).success, true)
  assert.equal(
    MessageSchema.safeParse({ ...base, parts: undefined }).success,
    false,
  )
  assert.equal(
    MessageSchema.safeParse({
      ...base,
      parts: [{ type: 'image', assetId: 'a1', mimeType: 'image/png' }],
    }).success,
    true,
  )
  assert.equal(
    MessageSchema.safeParse({
      ...base,
      parts: [{ type: 'image', dataUrl: 'data:image/png;base64,xx' }],
    }).success,
    false,
  )
})

test('RunSchema carries agent delegation fields and awaiting_approval', () => {
  const run = {
    id: 'r1',
    sessionId: 's1',
    status: 'awaiting_approval',
    providerId: null,
    model: null,
    startedAt: NOW,
    completedAt: null,
    errorCode: null,
    retryOfRunId: null,
    agentId: null,
    parentRunId: null,
    delegationId: null,
    skillId: null,
  }
  assert.equal(RunSchema.safeParse(run).success, true)
  assert.equal(
    RunSchema.safeParse({ ...run, status: 'waiting' }).success,
    false,
  )
  assert.equal(
    RunSchema.safeParse({
      ...run,
      agentId: 'agent-1',
      parentRunId: 'r0',
      delegationId: 'd1',
    }).success,
    true,
  )
})

test('ToolCallSchema and ToolSpecSchema validate dynamic args', () => {
  const toolCall = {
    id: 't1',
    runId: 'r1',
    messageId: 'm1',
    toolName: 'file.read',
    args: { path: 'src/app.ts' },
    result: null,
    status: 'pending',
    errorCode: null,
    approvalGrantId: null,
    createdAt: NOW,
    completedAt: null,
  }
  assert.equal(ToolCallSchema.safeParse(toolCall).success, true)
  assert.equal(
    ToolCallSchema.safeParse({
      ...toolCall,
      args: { nested: [{ deep: [1, 'two', null, { more: true }] }] },
      result: { rows: 3 },
      status: 'completed',
      completedAt: NOW,
    }).success,
    true,
  )
  // 非法状态与非 JSON 负载被拒绝。
  assert.equal(
    ToolCallSchema.safeParse({ ...toolCall, status: 'open' }).success,
    false,
  )
  assert.equal(
    ToolCallSchema.safeParse({ ...toolCall, args: undefined }).success,
    false,
  )

  assert.equal(
    ToolSpecSchema.safeParse({
      name: 'file.read',
      description: '读取文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }).success,
    true,
  )
})

test('ProviderProfileSchema requires capability list', () => {
  const profile = {
    id: 'pp1',
    name: 'main',
    baseUrl: 'https://api.example.com/v1',
    models: ['m1'],
    capabilities: ['chat', 'embedding'],
    secretRef: 'local:a',
    enabled: true,
    updatedAt: NOW,
  }
  assert.equal(ProviderProfileSchema.safeParse(profile).success, true)
  assert.equal(
    ProviderProfileSchema.safeParse({ ...profile, capabilities: [] }).success,
    true,
  )
  assert.equal(
    ProviderProfileSchema.safeParse({ ...profile, capabilities: ['stt'] })
      .success,
    false,
  )
  assert.equal(
    ProviderProfileSchema.safeParse({ ...profile, capabilities: undefined })
      .success,
    false,
  )
})

test('message.send params require requestId, sessionId and content', () => {
  const params = CommandSchemaRegistry['message.send'].params
  assert.equal(
    params.safeParse({ requestId: 'r1', sessionId: 's1', content: 'hi' })
      .success,
    true,
  )
  assert.equal(
    params.safeParse({ sessionId: 's1', content: 'hi' }).success,
    false,
  )
  assert.equal(params.safeParse({ requestId: 'r1' }).success, false)
})

test('ChatCommand alias matches MessageSendParamsSchema', () => {
  const parsed = MessageSendParamsSchema.parse({
    requestId: 'r1',
    sessionId: 's1',
    content: 'hi',
  })
  assert.equal(parsed.requestId, 'r1')
})

test('RuntimeEventSchema validates message.delta envelope and rejects unknown type', () => {
  const delta = {
    type: 'message.delta',
    protocolVersion: '1.0',
    eventId: 'e1',
    runId: 'r1',
    seq: 3,
    occurredAt: NOW,
    messageId: 'm1',
    chunkSeq: 0,
    delta: 'he',
  }
  assert.equal(RuntimeEventSchema.safeParse(delta).success, true)

  const missingSeq = { ...delta }
  delete missingSeq.seq
  assert.equal(RuntimeEventSchema.safeParse(missingSeq).success, false)

  assert.equal(
    RuntimeEventSchema.safeParse({ ...delta, type: 'message.exploded' })
      .success,
    false,
  )
})

test('RuntimeErrorSchema enforces stable error codes', () => {
  assert.equal(
    RuntimeErrorSchema.safeParse({ code: 'rate_limit', message: 'slow down' })
      .success,
    true,
  )
  assert.equal(
    RuntimeErrorSchema.safeParse({ code: 'RATE_LIMIT', message: 'slow down' })
      .success,
    false,
  )
})

test('JsonRpcMessageSchema separates requests, responses and garbage', () => {
  assert.equal(
    JsonRpcMessageSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      method: 'message.send',
    }).success,
    true,
  )
  assert.equal(
    JsonRpcMessageSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'nope' },
    }).success,
    true,
  )
  assert.equal(
    JsonRpcMessageSchema.safeParse({ jsonrpc: '2.0' }).success,
    false,
  )
  assert.equal(
    JsonRpcMessageSchema.safeParse({ id: 1, method: 'x' }).success,
    false,
  )
})

test('jsonSchemas registry exports JSON Schema for entities and commands', () => {
  assert.ok(jsonSchemas['Project'])
  assert.ok(jsonSchemas['message.send.params'])
  assert.ok(jsonSchemas['JsonRpcMessage'])
})

test('provider.configure accepts models and optional capabilities', () => {
  const params = CommandSchemaRegistry['provider.configure'].params
  const base = {
    requestId: 'r1',
    name: 'mock',
    baseUrl: 'https://api.example.com/v1',
    secret: 'sk-test',
  }
  assert.equal(
    params.safeParse({ ...base, models: ['gpt-mock'] }).success,
    true,
  )
  // 省略 secret 走 secretRef 编辑路径。
  assert.equal(
    params.safeParse({ ...base, models: ['gpt-mock'] }).success,
    true,
  )
  assert.equal(
    params.safeParse({
      ...base,
      models: ['gpt-mock'],
      capabilities: ['chat', 'image'],
    }).success,
    true,
  )
  assert.equal(
    params.safeParse({ ...base, models: ['gpt-mock'], capabilities: ['stt'] })
      .success,
    false,
  )
  assert.equal(params.safeParse({ ...base }).success, false)
})

test('session.get result carries session, messages, runs and toolCalls', () => {
  const result = CommandSchemaRegistry['session.get'].result
  assert.equal(
    result.safeParse({ session: null, messages: [], runs: [], toolCalls: [] })
      .success,
    true,
  )
  assert.equal(result.safeParse({ session: null }).success, false)
  assert.equal(result.safeParse({ messages: [], runs: [] }).success, false)
  // toolCalls 为必填：无工具调用时是空数组，而不是缺字段。
  assert.equal(
    result.safeParse({ session: null, messages: [], runs: [] }).success,
    false,
  )
})

test('tool and approval events validate envelope payloads', () => {
  const envelope = {
    protocolVersion: '1.0',
    eventId: 'e1',
    runId: 'r1',
    seq: 0,
    occurredAt: NOW,
  }
  const cases = [
    {
      type: 'tool.requested',
      toolCallId: 't1',
      toolName: 'file.read',
      args: { path: 'a.ts' },
    },
    {
      type: 'tool.completed',
      toolCallId: 't1',
      status: 'failed',
      errorCode: 'timeout',
    },
    {
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'shell.execute',
      summary: 'rm -rf build',
    },
    {
      type: 'approval.resolved',
      toolCallId: 't1',
      decision: 'approved',
      scope: 'session',
    },
  ]
  for (const payload of cases) {
    assert.equal(
      RuntimeEventSchema.safeParse({ ...envelope, ...payload }).success,
      true,
      payload.type,
    )
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'process.spawn',
      summary: 'x',
    }).success,
    false,
  )
})

test('FinishReason includes tool_calls', () => {
  assert.equal(FinishReasonSchema.safeParse('tool_calls').success, true)
  assert.equal(FinishReasonSchema.safeParse('function_call').success, false)
})

test('MemorySchema validates scope/kind/status and nullable scopeId', () => {
  const memory = {
    id: 'mem1',
    scope: 'project',
    scopeId: 'p1',
    kind: 'fact',
    content: '项目使用 pnpm workspace 管理。',
    sourceRunId: 'r1',
    confidence: 0.9,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
  }
  assert.equal(MemorySchema.safeParse(memory).success, true)
  // user 级 scopeId 为 null；session/project 必须可回溯。
  assert.equal(
    MemorySchema.safeParse({ ...memory, scope: 'user', scopeId: null }).success,
    true,
  )
  assert.equal(
    MemorySchema.safeParse({ ...memory, scope: 'session', scopeId: null })
      .success,
    false,
  )
  assert.equal(
    MemorySchema.safeParse({ ...memory, kind: 'secret' }).success,
    false,
  )
  assert.equal(
    MemorySchema.safeParse({ ...memory, status: 'deleted' }).success,
    false,
  )
  assert.equal(
    MemorySchema.safeParse({ ...memory, confidence: 1.5 }).success,
    false,
  )
  assert.equal(
    MemorySchema.safeParse({ ...memory, content: '' }).success,
    false,
  )
})

test('memory commands validate params and results', () => {
  const list = CommandSchemaRegistry['memory.list'].params
  assert.equal(list.safeParse({ requestId: 'r1' }).success, true)
  assert.equal(
    list.safeParse({ requestId: 'r1', scope: 'project' }).success,
    true,
  )
  assert.equal(
    list.safeParse({ requestId: 'r1', scope: 'user', scopeId: null }).success,
    true,
  )
  assert.equal(
    list.safeParse({ requestId: 'r1', scope: 'galaxy' }).success,
    false,
  )

  const update = CommandSchemaRegistry['memory.update'].params
  assert.equal(
    update.safeParse({ requestId: 'r1', id: 'm1', status: 'pinned' }).success,
    true,
  )
  assert.equal(
    update.safeParse({ requestId: 'r1', id: 'm1', content: '新内容' }).success,
    true,
  )
  assert.equal(update.safeParse({ requestId: 'r1' }).success, false)

  const del = CommandSchemaRegistry['memory.delete'].params
  assert.equal(del.safeParse({ requestId: 'r1', id: 'm1' }).success, true)
  assert.equal(del.safeParse({ requestId: 'r1' }).success, false)
})

test('memory.written event validates memory payloads', () => {
  const envelope = {
    protocolVersion: '1.0',
    eventId: 'e1',
    runId: 'r1',
    seq: 0,
    occurredAt: NOW,
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'memory.written',
      memories: [
        {
          id: 'mem1',
          scope: 'session',
          scopeId: 's1',
          kind: 'preference',
          content: '用户偏好中文回复。',
          sourceRunId: 'r1',
          confidence: 0.8,
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
          expiresAt: null,
        },
      ],
    }).success,
    true,
  )
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'memory.written',
    }).success,
    false,
  )
})
