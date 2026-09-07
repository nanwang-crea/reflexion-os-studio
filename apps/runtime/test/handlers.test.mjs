import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { createTaskTool } from '../dist/agent/tools/task.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { ChatAgent } from '../dist/agent/index.js'

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
  const agent = new ChatAgent(store, () => {}, null)
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
  const starter = agent.createChildRunStarter(
    parentRun,
    session,
    { id: 'provider', models: ['model'] },
    'unused',
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
