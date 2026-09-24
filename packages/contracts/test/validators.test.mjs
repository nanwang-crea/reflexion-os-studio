import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandSchemaRegistry,
  FinishReasonSchema,
  JsonRpcMessageSchema,
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
  ToolOutputSchema,
  coerceToolOutput,
  ToolSpecSchema,
  jsonSchemas,
  parseResourceUri,
  PermissionPresetSchema,
  ApprovalOverrideSchema,
  SandboxPolicySchema,
  ApprovalSubjectSchema,
  ApprovalChoiceSchema,
  ApprovalContextSchema,
  ApprovalGrantV2Schema,
  ShellExecuteParamsSchema,
  DangerAccessLeaseSchema,
  QueueEntrySchema,
  PluginPackageManifestSchema,
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

test('ToolOutputSchema validates canonical output and wraps legacy result_json', () => {
  const legacy = {
    changedFiles: [{ path: 'src/a.ts', action: 'modified' }],
    writtenBytes: 2,
  }
  const output = coerceToolOutput(legacy)
  assert.equal(ToolOutputSchema.safeParse(output).success, true)
  assert.equal(output.content, JSON.stringify(legacy))
  assert.deepEqual(output.data, legacy)
  assert.deepEqual(output.changedFiles, legacy.changedFiles)
  assert.deepEqual(output.resourceLinks, [])
})

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

test('message.edit_resend requires the replaced message id', () => {
  const params = CommandSchemaRegistry['message.edit_resend'].params
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      sessionId: 's1',
      messageId: 'm1',
      content: 'revised prompt',
    }).success,
    true,
  )
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      sessionId: 's1',
      content: 'revised prompt',
    }).success,
    false,
  )
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

// ---------------- 权限模型 V2 ----------------

test('PermissionPreset 三档严格枚举：旧值必须走兼容映射而非直入', () => {
  for (const value of ['workspace-read', 'workspace-write', 'workspace-full']) {
    assert.equal(PermissionPresetSchema.safeParse(value).success, true, value)
  }
  // legacy 档位名与 trusted 布尔都不是 preset。
  for (const value of ['workspace', 'read-only', 'trusted', 'danger']) {
    assert.equal(PermissionPresetSchema.safeParse(value).success, false, value)
  }
})

test('ApprovalOverride 只接受 default/ask-everything；SandboxPolicy 四档', () => {
  assert.equal(ApprovalOverrideSchema.safeParse('ask-everything').success, true)
  assert.equal(ApprovalOverrideSchema.safeParse('default').success, true)
  assert.equal(ApprovalOverrideSchema.safeParse('ask-all').success, false)
  for (const value of ['read-only', 'workspace-write', 'escalated', 'danger']) {
    assert.equal(SandboxPolicySchema.safeParse(value).success, true, value)
  }
  assert.equal(SandboxPolicySchema.safeParse('no-sandbox').success, false)
})

test('ApprovalSubject 判别联合：三种主题各自校验，模型不可伪造 shell 主题', () => {
  assert.equal(
    ApprovalSubjectSchema.safeParse({
      kind: 'operation',
      operation: 'web.fetch',
    }).success,
    true,
  )
  assert.equal(
    ApprovalSubjectSchema.safeParse({
      kind: 'workspace-path',
      operation: 'file.edit',
      path: 'apps/runtime/src/agent/permissions.ts',
    }).success,
    true,
  )
  assert.equal(
    ApprovalSubjectSchema.safeParse({
      kind: 'shell-command',
      operation: 'shell.execute',
      commandDigest: 'sha256:abc',
      displayCommand: 'pnpm test --filter runtime',
      prefixCandidate: ['pnpm', 'test'],
      escalation: false,
      network: false,
    }).success,
    true,
  )
  // workspace-path 的 path 不得为空。
  assert.equal(
    ApprovalSubjectSchema.safeParse({
      kind: 'workspace-path',
      operation: 'file.read',
      path: '',
    }).success,
    false,
  )
  // shell-command 授权身份用 digest，缺 digest 非法。
  assert.equal(
    ApprovalSubjectSchema.safeParse({
      kind: 'shell-command',
      operation: 'shell.execute',
      displayCommand: 'ls',
      prefixCandidate: null,
      escalation: false,
      network: false,
    }).success,
    false,
  )
  // 未知 kind 拒绝。
  assert.equal(
    ApprovalSubjectSchema.safeParse({ kind: 'url', operation: 'x' }).success,
    false,
  )
})

test('ApprovalChoice/Runtime 下发协议：presentation 不携带授权语义', () => {
  assert.equal(
    ApprovalChoiceSchema.safeParse({
      id: 'session:file.edit',
      decision: 'approved',
      presentation: 'session-menu',
      label: '本会话允许读取并编辑此文件',
      description: '仅当前工作区内此路径',
    }).success,
    true,
  )
  // 没有 effect 字段可塞：choice 只有展示语义。
  assert.equal(
    ApprovalChoiceSchema.safeParse({
      id: 'x',
      decision: 'approved',
      presentation: 'primary',
      label: 'L',
      effect: { grantAll: true },
    }).success,
    true, // zod 默认剥离未知键，effect 不可能透传。
  )
  assert.equal(
    ApprovalChoiceSchema.safeParse({
      id: 'x',
      decision: 'maybe',
      presentation: 'primary',
      label: 'L',
    }).success,
    false,
  )
  assert.equal(
    ApprovalContextSchema.safeParse({
      displayCwd: '…/repo',
      workspaceScope: 'outside',
      sandbox: 'escalated',
      sandboxProvider: 'seatbelt',
      network: false,
      escalation: true,
      justification: 'read git config',
    }).success,
    true,
  )
  assert.equal(
    ApprovalContextSchema.safeParse({
      displayCwd: null,
      workspaceScope: 'everywhere',
      sandbox: 'read-only',
      sandboxProvider: null,
      network: false,
      escalation: false,
      justification: null,
    }).success,
    false,
  )
})

test('approval.required 携带 V2 字段；历史事件（无新字段）仍可回放', () => {
  const v2 = RuntimeEventSchema.safeParse({
    ...RUN_ENV,
    type: 'approval.required',
    toolCallId: 't1',
    sessionId: 's1',
    operation: 'shell.execute',
    summary: 'shell.execute: pnpm test',
    subject: {
      kind: 'shell-command',
      operation: 'shell.execute',
      commandDigest: 'sha256:abc',
      displayCommand: 'pnpm test',
      prefixCandidate: ['pnpm', 'test'],
      escalation: false,
      network: false,
    },
    risk: 'normal',
    context: {
      displayCwd: '…/repo',
      workspaceScope: 'inside',
      sandbox: 'workspace-write',
      sandboxProvider: 'seatbelt',
      network: false,
      escalation: false,
      justification: null,
    },
    choices: [
      {
        id: 'allow-once',
        decision: 'approved',
        presentation: 'primary',
        label: '允许一次',
      },
      {
        id: 'deny',
        decision: 'denied',
        presentation: 'secondary',
        label: '拒绝',
      },
    ],
  })
  assert.equal(v2.success, true, JSON.stringify(v2.error?.issues ?? null))
  // 旧 payload 保持可解析（run_events 历史回放）。
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...RUN_ENV,
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'file.write',
      summary: 'x',
    }).success,
    true,
  )
  // choices 存在但成员畸形必须拒绝：前端渲染以协议为准。
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...RUN_ENV,
      type: 'approval.required',
      toolCallId: 't1',
      operation: 'file.write',
      summary: 'x',
      choices: [
        { id: '', decision: 'approved', presentation: 'primary', label: '' },
      ],
    }).success,
    false,
  )
  // approval.resolved 新增可选 choiceId；grantScope 依旧必填。
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...RUN_ENV,
      type: 'approval.resolved',
      toolCallId: 't1',
      decision: 'approved',
      grantScope: 'session',
      choiceId: 'session:file.edit',
    }).success,
    true,
  )
})

test('approval.resolve 只接受 toolCallId + choiceId，旧 decision/scope 失效', () => {
  const params = CommandSchemaRegistry['approval.resolve'].params
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      toolCallId: 't1',
      choiceId: 'allow-once',
    }).success,
    true,
  )
  assert.equal(
    params.safeParse({
      requestId: 'r1',
      toolCallId: 't1',
      decision: 'approved',
      scope: 'session',
    }).success,
    false,
  )
})

test('MessageSend permissionPreset 可选；legacy permissionMode/trusted 一版本兼容', () => {
  const base = { requestId: 'r1', sessionId: 's1', content: 'hi' }
  assert.equal(
    MessageSendParamsSchema.safeParse({
      ...base,
      permissionPreset: 'workspace-write',
    }).success,
    true,
  )
  assert.equal(
    MessageSendParamsSchema.safeParse({
      ...base,
      permissionPreset: 'danger',
    }).success,
    false,
  )
  // legacy 字段仍可解析（兼容读取一个版本）。
  assert.equal(
    MessageSendParamsSchema.safeParse({
      ...base,
      permissionMode: 'read-only',
      trusted: true,
    }).success,
    true,
  )
})

test('QueueEntry 快照 permissionPreset', () => {
  const entry = {
    id: 'q1',
    sessionId: 's1',
    content: 'next',
    providerId: null,
    model: null,
    permissionPreset: 'workspace-full',
    skillId: null,
    position: 0,
  }
  const parsed = QueueEntrySchema.safeParse(entry)
  assert.equal(parsed.success, true)
  assert.equal(parsed.data.permissionPreset, 'workspace-full')
  assert.equal(
    QueueEntrySchema.safeParse({ ...entry, permissionPreset: undefined })
      .success,
    false,
  )
})

test('ApprovalGrantV2：版本、来源与 subjectDigest 硬校验', () => {
  const grant = {
    version: 2,
    grantId: 'g1',
    requestId: 'r1',
    sessionId: 's1',
    workspaceId: '/w',
    operation: 'file.write',
    source: 'session-rule',
    subjectDigest: 'sha256:def',
    sandbox: 'workspace-write',
    sandboxNetwork: false,
    expiresAt: 1789603200000,
  }
  assert.equal(ApprovalGrantV2Schema.safeParse(grant).success, true)
  assert.equal(
    ApprovalGrantV2Schema.safeParse({ ...grant, version: 1 }).success,
    false,
  )
  assert.equal(
    ApprovalGrantV2Schema.safeParse({ ...grant, source: 'permanent' }).success,
    false,
  )
  assert.equal(
    ApprovalGrantV2Schema.safeParse({ ...grant, subjectDigest: '' }).success,
    false,
  )
  // escalated 提权根：形状受控（非空、上限 8 条）。
  assert.equal(
    ApprovalGrantV2Schema.safeParse({
      ...grant,
      sandbox: 'escalated',
      escalationRoots: ['/Users/dev/notes'],
    }).success,
    true,
  )
  assert.equal(
    ApprovalGrantV2Schema.safeParse({
      ...grant,
      escalationRoots: [''],
    }).success,
    false,
  )
})

test('shell.execute 参数：require_escalated 必须携带非空 justification', () => {
  assert.equal(
    ShellExecuteParamsSchema.safeParse({ command: 'ls' }).success,
    true,
  )
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'git fetch',
      requires_network: true,
    }).success,
    true,
  )
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'git config --global user.name',
      sandbox_permissions: 'require_escalated',
    }).success,
    false,
  )
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'git config --global user.name',
      sandbox_permissions: 'require_escalated',
      justification: '   ',
    }).success,
    false,
  )
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'git config --global user.name',
      sandbox_permissions: 'require_escalated',
      justification: '需要读取全局 git 配置回答用户问题',
    }).success,
    true,
  )
  // prefix_rule 是候选而非授权：长度受控。
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'pnpm test',
      prefix_rule: ['pnpm', 'test'],
    }).success,
    true,
  )
  assert.equal(
    ShellExecuteParamsSchema.safeParse({
      command: 'x',
      prefix_rule: new Array(20).fill('a'),
    }).success,
    false,
  )
})

test('danger 命令注册：两段式确认与状态查询', () => {
  const prepare = CommandSchemaRegistry['danger.prepare']
  assert.equal(
    prepare.params.safeParse({ requestId: 'r1', sessionId: 's1' }).success,
    true,
  )
  const capability = {
    supported: true,
    provider: 'seatbelt',
    detail: null,
  }
  assert.equal(
    prepare.result.safeParse({
      challengeId: 'c1',
      expiresAt: 1789603200000,
      warning: '将跳过工作区内外审批 30 分钟',
      capability,
    }).success,
    true,
  )
  const enable = CommandSchemaRegistry['danger.enable']
  assert.equal(
    enable.params.safeParse({
      requestId: 'r1',
      challengeId: 'c1',
      acceptedRisk: true,
    }).success,
    true,
  )
  // acceptedRisk 必须是字面量 true：缺省或 false 都不构成明确确认。
  assert.equal(
    enable.params.safeParse({ requestId: 'r1', challengeId: 'c1' }).success,
    false,
  )
  assert.equal(
    enable.params.safeParse({
      requestId: 'r1',
      challengeId: 'c1',
      acceptedRisk: false,
    }).success,
    false,
  )
  assert.equal(
    enable.result.safeParse({
      lease: {
        sessionId: 's1',
        issuedAt: 1789600000000,
        expiresAt: 1789601800000,
        enforcement: 'credential-guard',
        provider: 'seatbelt',
      },
    }).success,
    true,
  )
  // enforcement 只有 credential-guard 一种：裸 NoopSandbox 不是合法租约。
  assert.equal(
    DangerAccessLeaseSchema.safeParse({
      sessionId: 's1',
      issuedAt: 1,
      expiresAt: 2,
      enforcement: 'none',
      provider: 'seatbelt',
    }).success,
    false,
  )
  assert.equal(
    CommandSchemaRegistry['danger.disable'].result.safeParse({
      disabled: true,
    }).success,
    true,
  )
  assert.equal(
    CommandSchemaRegistry['danger.status'].result.safeParse({
      lease: null,
    }).success,
    true,
  )
})

test('danger.changed 事件：会话作用域的租约生命周期', () => {
  const env = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'e1',
    scope: 'session',
    sessionId: 's1',
    seq: 0,
    occurredAt: NOW,
  }
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...env,
      type: 'danger.changed',
      lease: {
        sessionId: 's1',
        issuedAt: 1,
        expiresAt: 2,
        enforcement: 'credential-guard',
        provider: 'bwrap',
      },
      reason: null,
    }).success,
    true,
  )
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...env,
      type: 'danger.changed',
      lease: null,
      reason: 'provider-degraded',
    }).success,
    true,
  )
  assert.equal(
    RuntimeEventSchema.safeParse({
      ...env,
      type: 'danger.changed',
      lease: null,
      reason: 'unbounded-generosity',
    }).success,
    false,
  )
})

test('permission.approval_override set/get 命令注册', () => {
  const set = CommandSchemaRegistry['permission.approval_override.set']
  assert.equal(
    set.params.safeParse({
      requestId: 'r1',
      sessionId: 's1',
      override: 'ask-everything',
    }).success,
    true,
  )
  assert.equal(
    set.params.safeParse({ requestId: 'r1', sessionId: 's1' }).success,
    false,
  )
  const get = CommandSchemaRegistry['permission.approval_override.get']
  assert.equal(get.result.safeParse({ override: 'default' }).success, true)
})

test('plugin.json contract validates type, entry, compatibility and permissions', () => {
  const manifest = {
    manifestVersion: 1,
    id: 'review-plus',
    name: 'Review Plus',
    version: '1.2.0',
    description: 'Review workflow',
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: '>=1.3 <2.0' },
    capabilities: ['skill.instructions'],
    permissions: {
      filesystem: 'workspace-read',
      network: false,
      shell: false,
    },
    skill: { tools: ['file.read'], argumentHint: '<path>' },
  }
  assert.equal(PluginPackageManifestSchema.safeParse(manifest).success, true)
  assert.equal(
    PluginPackageManifestSchema.safeParse({
      ...manifest,
      entry: '../SKILL.md',
    }).success,
    false,
  )
  assert.equal(
    PluginPackageManifestSchema.safeParse({
      ...manifest,
      capabilities: ['tool.execute'],
    }).success,
    false,
  )
})

test('协议版本升级到 1.3', () => {
  assert.equal(PROTOCOL_VERSION, '1.3')
})
