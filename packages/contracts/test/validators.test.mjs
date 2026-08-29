import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandSchemaRegistry,
  JsonRpcMessageSchema,
  MessageSendParamsSchema,
  MessageStatusSchema,
  MessageSchema,
  ProjectSchema,
  RuntimeErrorSchema,
  RuntimeEventSchema,
  jsonSchemas,
} from '../dist/index.js'

const NOW = '2026-08-29T00:00:00.000Z'

test('ProjectSchema accepts a valid project and rejects missing fields', () => {
  const project = {
    id: 'p1',
    name: 'Demo',
    createdAt: NOW,
    updatedAt: NOW,
  }
  assert.equal(ProjectSchema.safeParse(project).success, true)

  const missingTimestamp = { ...project, createdAt: undefined }
  assert.equal(ProjectSchema.safeParse(missingTimestamp).success, false)

  const badTimestamp = { ...project, updatedAt: 'yesterday' }
  assert.equal(ProjectSchema.safeParse(badTimestamp).success, false)
})

test('MessageSchema enforces role and status enums', () => {
  const base = {
    id: 'm1',
    sessionId: 's1',
    runId: 'r1',
    role: 'user',
    content: 'hello',
    status: 'pending',
    createdAt: NOW,
    completedAt: null,
  }
  assert.equal(MessageSchema.safeParse(base).success, true)

  const badStatus = { ...base, status: 'done' }
  assert.equal(MessageSchema.safeParse(badStatus).success, false)
  assert.equal(MessageStatusSchema.safeParse('streaming').success, true)
  assert.equal(MessageStatusSchema.safeParse('complete').success, false)
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

test('provider.configure accepts write-only secret without secretRef', () => {
  const params = CommandSchemaRegistry['provider.configure'].params
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      name: 'mock',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-mock',
      secret: 'sk-test',
    }).success,
    true,
  )
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      name: 'mock',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-mock',
    }).success,
    true,
  )
})

test('session.get result carries session, messages and runs', () => {
  const result = CommandSchemaRegistry['session.get'].result
  assert.equal(
    result.safeParse({ session: null, messages: [], runs: [] }).success,
    true,
  )
  assert.equal(result.safeParse({ session: null }).success, false)
  assert.equal(result.safeParse({ messages: [], runs: [] }).success, false)
})
