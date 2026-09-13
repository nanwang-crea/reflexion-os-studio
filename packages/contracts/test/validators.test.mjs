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
  PlanSchema,
  ProjectSchema,
  PROTOCOL_VERSION,
  ProviderProfileSchema,
  RunSchema,
  RuntimeErrorSchema,
  RuntimeEventSchema,
  TerminalSchema,
  ToolCallSchema,
  ToolSpecSchema,
  jsonSchemas,
  parseResourceUri,
} from '../dist/index.js'

const NOW = '2026-08-29T00:00:00.000Z'

const RUN_ENV = {
  protocolVersion: PROTOCOL_VERSION,
  eventId: 'e1',
  scope: 'run',
  runId: 'r1',
  seq: 0,
  occurredAt: NOW,
}

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
    planId: null,
    planStepId: null,
    startedAt: NOW,
    completedAt: null,
    errorCode: null,
    retryOfRunId: null,
    supersededByRunId: null,
    agentId: null,
    parentRunId: null,
    delegationId: null,
    skillId: null,
    usage: null,
  }
  assert.equal(RunSchema.safeParse(run).success, true)
  assert.equal(
    RunSchema.safeParse({
      ...run,
      usage: { promptTokens: 10, completionTokens: 5 },
    }).success,
    true,
  )
  assert.equal(
    RunSchema.safeParse({ ...run, status: 'waiting' }).success,
    false,
  )
  assert.equal(
    RunSchema.safeParse({
      ...run,
      usage: { promptTokens: -1, completionTokens: 0 },
    }).success,
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
    temperature: null,
    maxTokens: null,
    contextWindow: null,
    contextBudget: null,
    updatedAt: NOW,
  }
  assert.equal(ProviderProfileSchema.safeParse(profile).success, true)
  assert.equal(
    ProviderProfileSchema.safeParse({ ...profile, capabilities: [] }).success,
    true,
  )
  assert.equal(
    ProviderProfileSchema.safeParse({
      ...profile,
      temperature: 0.7,
      maxTokens: 4096,
      contextWindow: 128000,
      contextBudget: 64000,
    }).success,
    true,
  )
  assert.equal(
    ProviderProfileSchema.safeParse({ ...profile, temperature: 2.5 }).success,
    false,
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
    ...RUN_ENV,
    type: 'message.delta',
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
  // 旧信封（无 scope、只有 runId）必须被拒绝——版本代际不可混流。
  const legacy = { ...delta }
  delete legacy.scope
  assert.equal(RuntimeEventSchema.safeParse(legacy).success, false)
  // run 作用域事件不许带别的作用域。
  assert.equal(
    RuntimeEventSchema.safeParse({ ...delta, scope: 'project' }).success,
    false,
  )
})

test('RuntimeEventSchema message.reset requires envelope and messageId', () => {
  const envelope = {
    ...RUN_ENV,
    type: 'message.reset',
    messageId: 'm1',
  }
  assert.equal(RuntimeEventSchema.safeParse(envelope).success, true)

  const missingMessageId = { ...envelope }
  delete missingMessageId.messageId
  assert.equal(RuntimeEventSchema.safeParse(missingMessageId).success, false)

  assert.equal(
    RuntimeEventSchema.safeParse({ ...envelope, messageId: '' }).success,
    false,
  )
})

test('resource-scoped events require their identity and reject runId smuggling', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'e1',
    seq: 0,
    occurredAt: NOW,
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...base,
      type: 'runtime.status',
      scope: 'runtime',
      status: {
        state: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: '0.1.0',
        capabilities: ['chat'],
        chatAvailable: true,
        systemAvailable: false,
      },
    }).success,
    true,
  )
  // workspace.index.* 用 project 作用域 + projectId，不许再出现 runId。
  const progress = {
    ...base,
    type: 'workspace.index.progress',
    scope: 'project',
    projectId: 'p1',
    version: 1,
    files: 2,
    dirs: 1,
  }
  assert.equal(RuntimeEventSchema.safeParse(progress).success, true)
  assert.equal(
    RuntimeEventSchema.safeParse({ ...progress, scope: 'run', runId: 'r1' })
      .success,
    false,
  )
  const queue = {
    ...base,
    type: 'queue.changed',
    scope: 'session',
    sessionId: 's1',
    items: [],
  }
  assert.equal(RuntimeEventSchema.safeParse(queue).success, true)
  const mcp = {
    ...base,
    type: 'mcp.changed',
    scope: 'mcp',
    serverId: 'srv1',
    server: {
      id: 'srv1',
      name: 'demo',
      command: 'node',
      args: [],
      env: [],
      enabled: true,
      toolCount: 0,
      status: 'disabled',
      lastError: null,
      updatedAt: NOW,
    },
  }
  assert.equal(RuntimeEventSchema.safeParse(mcp).success, true)
  // terminal 作用域：projectId + terminalId 同时必填（W2 事件用，先锁契约）。
  const termState = {
    ...base,
    type: 'terminal.state',
    scope: 'terminal',
    projectId: 'p1',
    terminalId: 't1',
    status: 'running',
  }
  assert.equal(RuntimeEventSchema.safeParse(termState).success, true)
  const missingTerminalId = { ...termState }
  delete missingTerminalId.terminalId
  assert.equal(RuntimeEventSchema.safeParse(missingTerminalId).success, false)
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
  assert.ok(jsonSchemas['JsonRpcMessage'])
  for (const method of Object.keys(CommandSchemaRegistry)) {
    assert.ok(jsonSchemas[`${method}.params`], `${method} params schema`)
    assert.ok(jsonSchemas[`${method}.result`], `${method} result schema`)
  }
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

test('session.get result carries session, messages, runs, toolCalls, plans and runEvents', () => {
  const result = CommandSchemaRegistry['session.get'].result
  assert.equal(
    result.safeParse({
      session: null,
      messages: [],
      runs: [],
      toolCalls: [],
      plans: [],
      runEvents: [],
    }).success,
    true,
  )
  assert.equal(result.safeParse({ session: null }).success, false)
  assert.equal(result.safeParse({ messages: [], runs: [] }).success, false)
  // toolCalls 为必填：无工具调用时是空数组，而不是缺字段。
  assert.equal(
    result.safeParse({ session: null, messages: [], runs: [] }).success,
    false,
  )
  // runEvents 向后兼容可选：旧 Runtime snapshot 缺字段时接受并默认空数组，
  // 由下方专用测试覆盖。
  // plans 为必填：无计划时是空数组，而不是缺字段。
  assert.equal(
    result.safeParse({
      session: null,
      messages: [],
      runs: [],
      toolCalls: [],
      runEvents: [],
    }).success,
    false,
  )
  // 计划项通过 PlanSchema 校验（含步骤）。
  const plan = {
    id: 'pl1',
    sessionId: 's1',
    messageId: 'm1',
    goal: '重构模块 A',
    status: 'active',
    summary: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    steps: [
      {
        id: 'st1',
        planId: 'pl1',
        title: '第一步',
        status: 'pending',
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }
  assert.equal(PlanSchema.safeParse(plan).success, true)
  assert.equal(
    result.safeParse({
      session: null,
      messages: [],
      runs: [],
      toolCalls: [],
      plans: [plan],
      runEvents: [],
    }).success,
    true,
  )
  assert.equal(PlanSchema.safeParse({ ...plan, status: 'done' }).success, false)
})

// 新字段向后兼容：旧版 Runtime snapshot 不包含 runEvents 时必须仍能通过校验
// （transport 校验失败会导致整个 session.get 响应被丢弃，前端消息全部消失）。
test('session.get result tolerates missing runEvents from legacy runtimes', () => {
  const result = CommandSchemaRegistry['session.get'].result
  const parsed = result.safeParse({
    session: null,
    messages: [],
    runs: [],
    toolCalls: [],
    plans: [],
  })
  assert.equal(parsed.success, true)
  assert.deepEqual(parsed.data.runEvents, [])
})

test('tool and approval events validate envelope payloads', () => {
  const envelope = RUN_ENV
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
      grantScope: 'session',
    },
  ]
  for (const payload of cases) {
    assert.equal(
      RuntimeEventSchema.safeParse({ ...envelope, ...payload }).success,
      true,
      payload.type,
    )
  }
  // 动态工具名（MCP 的 serverId/toolName、Agent 侧 manage_plan 等）也应是合法操作：
  // 审批操作契约已从「仅内置操作」扩展为「内置操作或任意非空工具名」。
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'someServer/tool',
      summary: 'x',
    }).success,
    true,
  )
  // 空操作名仍非法：非空工具名约束是硬边界。
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...envelope,
      type: 'approval.required',
      toolCallId: 't1',
      operation: '',
      summary: 'x',
    }).success,
    false,
  )
})

test('approval.resolved 以 grantScope 承载授权范围，信封 scope 不被遮蔽', () => {
  const parsed = RuntimeEventSchema.safeParse({
    ...RUN_ENV,
    type: 'approval.resolved',
    toolCallId: 't1',
    decision: 'approved',
    grantScope: 'once',
  })
  assert.equal(parsed.success, true)
  // payload 的 once/session 只能出现在 grantScope；信封 scope 仍是 run。
  assert.equal(parsed.data.scope, 'run')
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...RUN_ENV,
      type: 'approval.resolved',
      toolCallId: 't1',
      decision: 'approved',
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
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'e1',
    scope: 'run',
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

test('workspace.list_dir carries pagination params and truncation result metadata', () => {
  const params = CommandSchemaRegistry['workspace.list_dir'].params
  const base = { requestId: 'r1', projectId: 'p1' }
  assert.equal(params.safeParse(base).success, true)
  assert.equal(
    params.safeParse({ ...base, path: 'src', offset: 0, limit: 50 }).success,
    true,
  )
  assert.equal(params.safeParse({ ...base, offset: -1 }).success, false)
  assert.equal(params.safeParse({ ...base, limit: 1.5 }).success, false)

  const result = CommandSchemaRegistry['workspace.list_dir'].result
  assert.equal(
    result.safeParse({ entries: [], truncated: false, returnedCount: 0 })
      .success,
    true,
  )
  assert.equal(
    result.safeParse({
      entries: [],
      truncated: true,
      returnedCount: 0,
      nextOffset: 50,
    }).success,
    true,
  )
  // truncated/returnedCount 必填；nextOffset 仅在有后续内容时出现。
  assert.equal(result.safeParse({ entries: [] }).success, false)
  assert.equal(
    result.safeParse({ entries: [], truncated: false }).success,
    false,
  )
})

test('workspace.git_diff returns two-sided content instead of diff text', () => {
  const result = CommandSchemaRegistry['workspace.git_diff'].result
  assert.equal(
    result.safeParse({
      repo: true,
      original: 'old content',
      modified: 'new content',
      truncated: false,
      binary: false,
    }).success,
    true,
  )
  // 新增文件：original 为空串；删除文件：modified 为空串。
  assert.equal(
    result.safeParse({
      repo: true,
      original: '',
      modified: 'whole file',
      truncated: false,
      binary: false,
    }).success,
    true,
  )
  // 旧契约的 diff 文本字段不再是合法结果（反向还原机制已移除）。
  assert.equal(
    result.safeParse({ repo: true, diff: '...diff text...', truncated: false })
      .success,
    false,
  )
  // binary/truncated 必填。
  assert.equal(
    result.safeParse({ repo: true, original: '', modified: '' }).success,
    false,
  )
})

test('parseResourceUri normalizes backslashes in workspace paths', () => {
  const link = parseResourceUri('workspace:///src\\agent\\runner.ts#L418-L426')
  assert.equal(link.kind, 'workspaceFile')
  assert.equal(link.projectId, '')
  assert.equal(link.path, 'src/agent/runner.ts')
  assert.equal(link.line, 418)
})

const TERMINAL_BASE = {
  terminalId: 't1',
  projectId: 'p1',
  // 初始目录=workspace 路径，不是 shell 当前目录。
  initialCwd: '/tmp/demo',
  shellArgv: ['/bin/zsh'],
  rows: 24,
  cols: 80,
  status: 'running',
  generation: 1,
  createdAt: NOW,
}

test('TerminalSchema accepts a valid terminal and rejects invalid shapes', () => {
  assert.equal(TerminalSchema.safeParse(TERMINAL_BASE).success, true)
  // exitCode 可选：缺省/ null（信号终止或不可得）/ 数字退出码皆合法。
  assert.equal(
    TerminalSchema.safeParse({ ...TERMINAL_BASE, exitCode: null }).success,
    true,
  )
  assert.equal(
    TerminalSchema.safeParse({ ...TERMINAL_BASE, exitCode: 0 }).success,
    true,
  )
  // 缺 terminalId 拒绝。
  const missingId = { ...TERMINAL_BASE }
  delete missingId.terminalId
  assert.equal(TerminalSchema.safeParse(missingId).success, false)
  // rows/cols 必须为正整数。
  assert.equal(
    TerminalSchema.safeParse({ ...TERMINAL_BASE, rows: 0 }).success,
    false,
  )
  // generation 非负整数；负数拒绝。
  assert.equal(
    TerminalSchema.safeParse({ ...TERMINAL_BASE, generation: -1 }).success,
    false,
  )
  // status 必须落在 TerminalStatus 枚举内。
  assert.equal(
    TerminalSchema.safeParse({ ...TERMINAL_BASE, status: 'paused' }).success,
    false,
  )
})

test('terminal.create params require requestId and projectId', () => {
  const params = CommandSchemaRegistry['terminal.create'].params
  assert.equal(
    params.safeParse({ requestId: 'r1', projectId: 'p1', rows: 24, cols: 80 })
      .success,
    true,
  )
  assert.equal(
    params.safeParse({ projectId: 'p1', rows: 24, cols: 80 }).success,
    false,
  )
  assert.equal(
    params.safeParse({ requestId: 'r1', rows: 24, cols: 80 }).success,
    false,
  )
  assert.equal(
    params.safeParse({ requestId: 'r1', projectId: 'p1', rows: 0, cols: 80 })
      .success,
    false,
  )
})

test('terminal.write rejects negative inputSeq and empty data', () => {
  const params = CommandSchemaRegistry['terminal.write'].params
  const base = {
    requestId: 'r1',
    projectId: 'p1',
    terminalId: 't1',
    data: 'aGk=',
  }
  assert.equal(params.safeParse({ ...base, inputSeq: 0 }).success, true)
  assert.equal(params.safeParse({ ...base, inputSeq: -1 }).success, false)
  assert.equal(
    params.safeParse({ ...base, inputSeq: 1, data: '' }).success,
    false,
  )
})

test('every terminal.* command is registered with params and result', () => {
  const methods = [
    'terminal.create',
    'terminal.list',
    'terminal.attach',
    'terminal.write',
    'terminal.resize',
    'terminal.ack',
    'terminal.close',
  ]
  for (const method of methods) {
    const entry = CommandSchemaRegistry[method]
    assert.ok(entry, `${method} registered`)
    assert.equal(
      typeof entry.params.safeParse,
      'function',
      `${method} params schema`,
    )
    assert.equal(
      typeof entry.result.safeParse,
      'function',
      `${method} result schema`,
    )
    // 命令 params 一律要求 requestId。
    assert.equal(entry.params.safeParse({}).success, false, method)
  }
})
