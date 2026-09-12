import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { createTaskTool } from '../dist/agent/tools/task.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { createChildRunStarter } from '../dist/agent/delegation.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-handlers-')))
}

test('workspace.list_dir forwards pagination and preserves metadata', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const result = await dispatchCommand(
    'workspace.list_dir',
    { projectId: project.id, path: 'src', offset: 3.9, limit: 2.8 },
    {
      store,
      system: {
        available: true,
        request: async (method, params) => {
          calls.push({ method, params })
          return {
            entries: [{ path: 'src/a.ts', kind: 'file', sizeBytes: 1 }],
            truncated: true,
            returnedCount: 1,
            nextOffset: 4,
          }
        },
      },
    },
  )
  assert.deepEqual(calls, [
    {
      method: 'file.list',
      params: {
        workspaceRoot: '/workspace',
        path: 'src',
        offset: 3,
        limit: 2,
      },
    },
  ])
  assert.deepEqual(result, {
    entries: [{ path: 'src/a.ts', kind: 'file', sizeBytes: 1 }],
    truncated: true,
    returnedCount: 1,
    nextOffset: 4,
  })
})

test('workspace.git_diff forwards staged flag and returns two-sided content', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const result = await dispatchCommand(
    'workspace.git_diff',
    { projectId: project.id, path: 'src/a.ts', staged: true },
    {
      store,
      system: {
        available: true,
        request: async (method, params) => {
          calls.push({ method, params })
          return {
            repo: true,
            original: 'head content',
            modified: 'index content',
            truncated: false,
            binary: false,
          }
        },
      },
    },
  )
  assert.deepEqual(calls, [
    {
      method: 'git.diff',
      params: { workspaceRoot: '/workspace', path: 'src/a.ts', staged: true },
    },
  ])
  assert.deepEqual(result, {
    repo: true,
    original: 'head content',
    modified: 'index content',
    truncated: false,
    binary: false,
  })
})

test('agent_settings.update passes nested settings to agent', async () => {
  const received = []
  const result = await dispatchCommand(
    'agent_settings.update',
    { settings: { requestTimeoutSec: 30, requestRetries: 2 } },
    {
      store: freshStore(),
      agent: {
        updateSettings: (settings) => {
          received.push(settings)
          return { settings }
        },
      },
    },
  )
  assert.deepEqual(received, [{ requestTimeoutSec: 30, requestRetries: 2 }])
  assert.deepEqual(result, {
    settings: { requestTimeoutSec: 30, requestRetries: 2 },
  })
})

test('child task starter rejects disabled agents before creating a delegation', async () => {
  const store = freshStore()
  const notifier = () => {}
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.agents.upsert({
    id: 'disabled-agent',
    name: 'Disabled',
    description: '',
    systemPrompt: '',
    enabled: false,
  })
  const launcher = {
    depthOf: () => 0,
    permissionModeOf: () => 'workspace',
    launch: () => {},
  }
  const starter = createChildRunStarter(
    {
      store,
      notifier,
      launcher,
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
    },
    parentRun,
    session,
  )
  await assert.rejects(
    () =>
      starter({
        task: 'do work',
        agentId: 'disabled-agent',
        parentRunId: parentRun.id,
        signal: new AbortController().signal,
      }),
    /agent not found or disabled: disabled-agent/,
  )
  assert.equal(store.delegations.listBySession(session.id).length, 0)
})

test('task tool rejects without starter and validates arguments', async () => {
  const base = { store: freshStore(), runId: 'run-1' }
  const unavailable = await createTaskTool(base).execute({
    args: { task: 'do work', agentId: 'agent-1' },
    signal: new AbortController().signal,
  })
  assert.equal(unavailable.isError, true)
  assert.equal(unavailable.code, 'unsupported')

  const starterCalls = []
  const tool = createTaskTool({
    ...base,
    childRunStarter: async (input) => {
      starterCalls.push(input)
      return 'done'
    },
  })
  await assert.rejects(
    () => tool.execute({ args: null, signal: new AbortController().signal }),
    /arguments must be an object/,
  )
  await assert.rejects(
    () =>
      tool.execute({
        args: { task: ' ' },
        signal: new AbortController().signal,
      }),
    /task is required/,
  )
  // agentId 可选：缺省时回退 'default'（与工具 schema required: ['task'] 一致）。
  const defaulted = await tool.execute({
    args: { task: 'do' },
    signal: new AbortController().signal,
  })
  assert.deepEqual(defaulted, { content: 'done', isError: false })
  assert.equal(starterCalls[0].agentId, 'default')
  const result = await tool.execute({
    args: { task: ' do ', agentId: ' agent-1 ' },
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { content: 'done', isError: false })
  assert.equal(starterCalls[1].parentRunId, 'run-1')
  assert.equal(starterCalls[1].agentId, 'agent-1')
})

test('tool registry: child has no task and allowedTools filters tools', () => {
  const baseCtx = () => ({
    store: {},
    sessionId: 's',
    messageId: 'm',
    runId: 'r',
    emitter: {},
    system: null,
    workspaceRoot: null,
    skills: { get: () => null, list: () => [] },
    mcp: null,
  })

  // 未注入 childRunStarter（子 Run 场景）：不注册 task，也不暴露写/Shell。
  const noStarter = createToolRegistry(baseCtx())
  assert.equal(noStarter.has('task'), false)
  assert.equal(noStarter.has('shell.execute'), false)
  assert.equal(noStarter.has('file.write'), false)

  // 注入 childRunStarter（Primary 场景）：task 可用。
  const primary = createToolRegistry({
    ...baseCtx(),
    childRunStarter: async () => 'x',
  })
  assert.equal(primary.has('task'), true)

  // allowedTools 白名单：仅注册名单内工具，其余（含 MCP/写工具）被过滤。
  const allowed = new Set(['get_current_time', 'file.read'])
  const scoped = createToolRegistry({ ...baseCtx(), allowedTools: allowed })
  const registeredNames = scoped.specs().map((tool) => tool.name)
  for (const name of registeredNames) {
    assert.equal(allowed.has(name), true, `unexpected tool: ${name}`)
  }
  assert.equal(scoped.has('web.fetch'), false)
  assert.equal(scoped.has('manage_plan'), false)
  assert.equal(scoped.has('update_plan'), false)
})

test('provider.configure forwards tuning fields with omitted, null, and value semantics', async () => {
  const store = freshStore()
  const base = {
    name: 'Test',
    baseUrl: 'https://example.test',
    models: ['model'],
    secret: 'secret',
  }
  const first = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      temperature: 0.4,
      maxTokens: 100,
      contextWindow: 1000,
      contextBudget: 700,
    },
    { store },
  )
  assert.equal(first.profile.temperature, 0.4)
  const kept = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      id: first.profile.id,
    },
    { store },
  )
  assert.equal(kept.profile.temperature, 0.4)
  assert.equal(kept.profile.maxTokens, 100)
  const cleared = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      id: first.profile.id,
      temperature: null,
      maxTokens: null,
      contextWindow: null,
      contextBudget: null,
    },
    { store },
  )
  assert.equal(cleared.profile.temperature, null)
  assert.equal(cleared.profile.maxTokens, null)
  assert.equal(cleared.profile.contextWindow, null)
  assert.equal(cleared.profile.contextBudget, null)
})

test('phase 3 isolation: enableChildRuns=true in stored settings is forced off on read', () => {
  const store = freshStore()
  // 模拟旧数据直接写入 enableChildRuns=true（绕过契约层的落库形态）。
  store.agentSettings.upsert({
    maxTurns: 8,
    reflectionThreshold: null,
    requestRetries: null,
    requestTimeoutSec: null,
    maxDepth: 2,
    maxChildRuns: 2,
    maxParallelChildren: 1,
    maxChildTimeoutSec: 60,
    maxChildTotalTokens: 8000,
    enableChildRuns: true,
  })
  const settings = store.agentSettings.get()
  assert.equal(settings.enableChildRuns, false)
  assert.equal(settings.maxTurns, 8)
})

test('phase 3 isolation: delegation write commands are unsupported, queries still work', async () => {
  const store = freshStore()
  await assert.rejects(
    () => dispatchCommand('delegation.create', {}, { store }),
    /unsupported|Phase 3/,
  )
  await assert.rejects(
    () => dispatchCommand('delegation.update', {}, { store }),
    /unsupported|Phase 3/,
  )
  await assert.rejects(
    () => dispatchCommand('delegation.attach_child_run', {}, { store }),
    /unsupported|Phase 3/,
  )
  // 查询命令保留：返回空列表而不是报错。
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const listed = await dispatchCommand(
    'delegation.list',
    { sessionId: session.id },
    { store },
  )
  assert.deepEqual(listed, { delegations: [] })
})

test('phase 3 isolation: tool registry never registers task without starter', () => {
  const baseCtx = () => ({
    store: {},
    sessionId: 's',
    messageId: 'm',
    runId: 'r',
    emitter: {},
    system: null,
    workspaceRoot: null,
    skills: { get: () => null, list: () => [] },
    mcp: null,
  })
  const registry = createToolRegistry(baseCtx())
  assert.equal(registry.has('task'), false)
})

test('workspace.read_file registers revision; write_file consumes it with source ui', async () => {
  const store = freshStore()
  const root = mkdtempSync(join(tmpdir(), 'reflexion-wsreg-'))
  const project = store.projects.create({ name: 'p', folderPath: root })
  const revision = { modifiedMs: 1000, sizeBytes: 6, sha256: 'a'.repeat(64) }
  const calls = []
  const system = {
    available: true,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'file.read') {
        return {
          content: 'hello\n',
          sizeBytes: 6,
          totalLines: 1,
          offset: 0,
          readComplete: true,
          revision,
        }
      }
      return { writtenBytes: 7, revision: { ...revision, modifiedMs: 2000 } }
    },
  }
  const ctx = { store, system }
  await dispatchCommand(
    'workspace.read_file',
    { projectId: project.id, path: 'a.txt' },
    ctx,
  )
  await dispatchCommand(
    'workspace.write_file',
    { projectId: project.id, path: 'a.txt', content: 'hello!\n' },
    ctx,
  )
  const write = calls.find((call) => call.method === 'file.write').params
  assert.deepEqual(write.revision, revision)
  assert.equal(write.source, 'ui')
  assert.equal('grant' in write, false)
  // 连续保存：写响应的新凭据回登记，第二次保存必须携带它。
  await dispatchCommand(
    'workspace.write_file',
    { projectId: project.id, path: 'a.txt', content: 'hello?\n' },
    ctx,
  )
  const second = calls.filter((call) => call.method === 'file.write')[1].params
  assert.deepEqual(second.revision, { ...revision, modifiedMs: 2000 })
})

test('workspace.write_file sends no revision without a prior read (new file)', async () => {
  const store = freshStore()
  const root = mkdtempSync(join(tmpdir(), 'reflexion-wsnew-'))
  const project = store.projects.create({ name: 'p', folderPath: root })
  const calls = []
  await dispatchCommand(
    'workspace.write_file',
    { projectId: project.id, path: 'new.txt', content: 'x' },
    {
      store,
      system: {
        available: true,
        request: async (method, params) => {
          calls.push({ method, params })
          return { writtenBytes: 1 }
        },
      },
    },
  )
  assert.equal(calls[0].method, 'file.write')
  assert.equal('revision' in calls[0].params, false)
  assert.equal(calls[0].params.source, 'ui')
  assert.equal('grant' in calls[0].params, false)
})

test('workspace.write_file rejects overwrite when last read was paginated', async () => {
  const store = freshStore()
  const root = mkdtempSync(join(tmpdir(), 'reflexion-wspart-'))
  const project = store.projects.create({ name: 'p', folderPath: root })
  const calls = []
  const system = {
    available: true,
    request: async (method, params) => {
      calls.push({ method, params })
      return {
        content: 'window\n',
        sizeBytes: 100,
        totalLines: 50,
        offset: 0,
        readComplete: false,
        revision: { modifiedMs: 1, sizeBytes: 100, sha256: 'c'.repeat(64) },
      }
    },
  }
  const ctx = { store, system }
  await dispatchCommand(
    'workspace.read_file',
    { projectId: project.id, path: 'big.txt', offset: 0, limit: 10 },
    ctx,
  )
  await assert.rejects(
    () =>
      dispatchCommand(
        'workspace.write_file',
        { projectId: project.id, path: 'big.txt', content: 'stomp\n' },
        ctx,
      ),
    /分页窗口/,
  )
  assert.equal(
    calls.some((call) => call.method === 'file.write'),
    false,
  )
})
