import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { normalizeProjectFolderPath } from '../dist/store/chat/project-path.js'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { createTaskTool } from '../dist/agent/tools/task.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import {
  createChildRunStarter,
  DelegationBudgetCoordinator,
  RootMutationCoordinator,
} from '../dist/agent/delegation.js'
import { composeSystemPrompt } from '../dist/agent/launcher.js'
import { createAgentInstance } from '../dist/agent/delegation/instance.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-handlers-')))
}

test('delegation budget is shared across the whole root tree', () => {
  const settings = {
    ...freshStore().agentSettings.get(),
    maxChildRuns: 2,
    maxParallelChildren: 1,
  }
  const budget = new DelegationBudgetCoordinator('root-run', settings)
  const first = budget.acquire()
  assert.throws(() => budget.acquire(), /整棵委派树的并发/)
  first.release()
  const second = budget.acquire()
  second.release()
  assert.throws(() => budget.acquire(), /整棵委派树的子 Agent 数量/)
})

test('root mutation coordinator serializes sibling writes', async () => {
  const coordinator = new RootMutationCoordinator()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const first = coordinator.run(async () => {
    order.push('first:start')
    await firstGate
    order.push('first:end')
  })
  const second = coordinator.run(async () => {
    order.push('second:start')
    order.push('second:end')
  })
  await Promise.resolve()
  assert.deepEqual(order, ['first:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ])
})

test('dynamic instance inherits writes while templates can only narrow', () => {
  const inheritedTools = new Set(['file.read', 'file.edit', 'shell.execute'])
  const dynamic = createAgentInstance({
    spawn: { name: 'Editor' },
    template: null,
    inheritedPreset: 'workspace-write',
    inheritedTools,
    permissionDomainId: 'root-session',
    canDelegateByDepth: true,
  })
  assert.equal(dynamic.permissionPreset, 'workspace-write')
  assert.deepEqual(dynamic.allowedTools, [
    'file.read',
    'file.edit',
    'shell.execute',
  ])

  const narrowed = createAgentInstance({
    spawn: { templateId: 'reviewer' },
    template: {
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Review only',
      systemPrompt: 'Review.',
      policy: {
        version: 1,
        permissionCeiling: 'workspace-read',
        allowedTools: ['file.read'],
        canDelegate: false,
      },
      enabled: true,
      source: 'builtin',
      builtin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    inheritedPreset: 'workspace-full',
    inheritedTools,
    permissionDomainId: 'root-session',
    canDelegateByDepth: true,
  })
  assert.equal(narrowed.permissionPreset, 'workspace-read')
  assert.deepEqual(narrowed.allowedTools, ['file.read'])
})

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

test('session.execution_mode.set only changes idle sessions', async () => {
  const store = freshStore()
  const session = store.sessions.create(null, 'mode')
  const changed = await dispatchCommand(
    'session.execution_mode.set',
    { sessionId: session.id, mode: 'plan' },
    { store },
  )
  assert.equal(changed.session.executionMode, 'plan')
  store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  await assert.rejects(
    () =>
      dispatchCommand(
        'session.execution_mode.set',
        { sessionId: session.id, mode: 'execute' },
        { store },
      ),
    /运行中的会话只能通过计划审批切换执行模式/,
  )
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
      model: 'model',
      sampling: {},
    },
    parentRun,
    session,
  )
  await assert.rejects(
    () =>
      starter({
        task: 'do work',
        agentId: 'disabled-agent',
        signal: new AbortController().signal,
      }),
    /agent not found or disabled: disabled-agent/,
  )
  assert.equal(store.delegations.listBySession(session.id).length, 0)
})

test('child task starter launches an isolated read-only child and persists its result', async () => {
  const store = freshStore()
  const events = []
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  let launchInput
  const launcher = {
    depthOf: () => 0,
    launch: (input) => {
      launchInput = input
      input.onResult('verified result')
    },
  }
  const starter = createChildRunStarter(
    {
      store,
      notifier: (event) => events.push(event),
      launcher,
      profile: {
        id: 'provider',
        models: ['profile-default', 'selected-model'],
      },
      apiKey: 'unused',
      model: 'selected-model',
      sampling: { temperature: 0.2, maxTokens: 4096 },
    },
    parentRun,
    session,
  )

  const result = await starter({
    task: 'review the implementation',
    agentId: 'reviewer',
    signal: new AbortController().signal,
  })

  assert.equal(result.summary, 'verified result')
  assert.deepEqual(result.resourceLinks, [])
  assert.equal(launchInput.depth, 1)
  assert.equal(launchInput.model, 'selected-model')
  assert.deepEqual(launchInput.sampling, {
    temperature: 0.2,
    maxTokens: 4096,
  })
  assert.equal(launchInput.permissionPreset, 'workspace-read')
  assert.equal(launchInput.isolatedContext, true)
  assert.equal(launchInput.childRunStarter, undefined)
  assert.equal(launchInput.allowedTools.has('file.read'), true)
  for (const forbidden of [
    'file.write',
    'shell.execute',
    'task',
    'manage_plan',
  ]) {
    assert.equal(launchInput.allowedTools.has(forbidden), false)
  }
  const [delegation] = store.delegations.listByParentRun(parentRun.id)
  assert.equal(delegation.status, 'completed')
  assert.equal(delegation.parentAgentId, null)
  assert.equal(delegation.childSessionId, launchInput.session.id)
  assert.equal(delegation.execution.version, 3)
  assert.equal(delegation.execution.rootRunId, parentRun.id)
  assert.equal(delegation.execution.depth, 1)
  assert.equal(delegation.execution.instance.canDelegate, false)
  assert.equal(delegation.execution.treeRunBudget, 4)
  assert.equal(delegation.structuredResult.summary, 'verified result')
  assert.equal(delegation.result, 'verified result')
  assert.equal(store.runs.get(delegation.childRunId).parentRunId, parentRun.id)
  assert.deepEqual(
    store.sessions.list(project.id).map((item) => item.id),
    [session.id],
  )
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith('delegation.'))
      .map((event) => [event.type, event.delegation.status]),
    [
      ['delegation.created', 'pending'],
      ['delegation.updated', 'running'],
      ['delegation.updated', 'completed'],
    ],
  )
})

test('an explicit default template overrides the parent model selection', async () => {
  const store = freshStore()
  const explicit = store.agents.saveUser({
    name: 'Explicit Reviewer',
    description: 'Chosen by the user',
    systemPrompt: 'Use the explicit review policy.',
    enabled: true,
    allowedTools: ['file.read'],
    canDelegate: false,
  })
  const modelChoice = store.agents.saveUser({
    name: 'Model Choice',
    description: 'Chosen by the parent model',
    systemPrompt: 'Use the model-selected policy.',
    enabled: true,
    allowedTools: ['file.read'],
    canDelegate: false,
  })
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  let launchInput
  const starter = createChildRunStarter(
    {
      store,
      notifier: () => {},
      launcher: {
        depthOf: () => 0,
        launch: (input) => {
          launchInput = input
          input.onResult('done')
        },
      },
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
      model: 'model',
      sampling: {},
      defaultTemplateId: explicit.id,
    },
    parentRun,
    session,
  )

  await starter({
    task: 'review this change',
    agent: { templateId: modelChoice.id },
    signal: new AbortController().signal,
  })

  const [delegation] = store.delegations.listByParentRun(parentRun.id)
  assert.equal(delegation.agentInstance.templateId, explicit.id)
  assert.match(launchInput.systemPrompt, /explicit review policy/)
})

test('parent cancellation propagates to the active child delegation', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  let childStarted
  const started = new Promise((resolve) => {
    childStarted = resolve
  })
  const launcher = {
    depthOf: () => 0,
    launch: (input) => {
      input.parentSignal.addEventListener('abort', input.onCancel, {
        once: true,
      })
      childStarted()
    },
  }
  const starter = createChildRunStarter(
    {
      store,
      notifier: () => {},
      launcher,
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
      model: 'model',
      sampling: {},
    },
    parentRun,
    session,
  )
  const parentController = new AbortController()
  const pending = starter({
    task: 'long read-only work',
    agentId: 'worker',
    signal: parentController.signal,
  })
  await started
  parentController.abort()

  await assert.rejects(pending, { name: 'AbortError' })
  const [delegation] = store.delegations.listByParentRun(parentRun.id)
  assert.equal(delegation.status, 'cancelled')
})

test('parent cancellation during child setup is not lost', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const parentController = new AbortController()
  const transaction = store.transaction.bind(store)
  store.transaction = (fn) => {
    const result = transaction(fn)
    parentController.abort()
    return result
  }
  const launcher = {
    depthOf: () => 0,
    launch: (input) => {
      assert.equal(input.parentSignal.aborted, true)
      input.onCancel()
    },
  }
  const starter = createChildRunStarter(
    {
      store,
      notifier: () => {},
      launcher,
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
      model: 'model',
      sampling: {},
    },
    parentRun,
    session,
  )

  await assert.rejects(
    starter({
      task: 'cancel during setup',
      agentId: 'worker',
      signal: parentController.signal,
    }),
    { name: 'AbortError' },
  )
  const [delegation] = store.delegations.listByParentRun(parentRun.id)
  assert.equal(delegation.status, 'cancelled')
})

test('child delegation exposes task only below the configured depth limit', async () => {
  const store = freshStore()
  store.agentSettings.upsert({
    ...store.agentSettings.get(),
    maxDepth: 2,
  })
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const launches = []
  const launcher = {
    depthOf: (runId) => (runId === parentRun.id ? 0 : 1),
    launch: (input) => {
      launches.push(input)
      input.onResult('done')
    },
  }
  const starter = createChildRunStarter(
    {
      store,
      notifier: () => {},
      launcher,
      profile: { id: 'provider', models: ['model'] },
      apiKey: 'unused',
      model: 'model',
      sampling: {},
    },
    parentRun,
    session,
  )

  await starter({
    task: 'level one',
    agentId: 'worker',
    signal: new AbortController().signal,
  })
  assert.equal(launches[0].allowedTools.has('task'), true)
  assert.equal(typeof launches[0].childRunStarter, 'function')

  await launches[0].childRunStarter({
    task: 'level two',
    agentId: 'reviewer',
    signal: new AbortController().signal,
  })
  assert.equal(launches[1].allowedTools.has('task'), false)
  assert.equal(launches[1].childRunStarter, undefined)
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
      return {
        version: 1,
        summary: 'done',
        resourceLinks: [],
        changedFiles: [],
        usage: null,
        toolCallCount: 0,
      }
    },
  })
  assert.match(tool.parameters.properties.agentId.description, /模板/)
  assert.doesNotMatch(
    tool.parameters.properties.agentId.description,
    /reviewer/,
  )
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
  // 模板可选：缺省时创建无模板动态实例。
  const defaulted = await tool.execute({
    args: { task: 'do' },
    signal: new AbortController().signal,
  })
  assert.equal(defaulted.content, 'done')
  assert.equal(defaulted.isError, false)
  assert.equal(starterCalls[0].agent.templateId, undefined)
  const result = await tool.execute({
    args: { task: ' do ', agentId: ' agent-1 ' },
    signal: new AbortController().signal,
  })
  assert.equal(result.content, 'done')
  assert.equal(result.isError, false)
  assert.equal('parentRunId' in starterCalls[1], false)
  assert.equal(starterCalls[1].agent.templateId, 'agent-1')
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
  assert.equal(
    primary.list().find((tool) => tool.name === 'task').execution.effect,
    'read',
  )

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

test('primary prompt projects enabled agents from the registry', () => {
  const store = freshStore()
  const reviewer = store.agents.get('reviewer')
  store.agents.upsert({
    id: reviewer.id,
    name: reviewer.name,
    description: reviewer.description,
    systemPrompt: reviewer.systemPrompt,
    enabled: false,
  })
  const prompt = composeSystemPrompt(
    { list: () => [] },
    null,
    store.agents.list(),
  )
  assert.match(prompt, /\[可用子 Agent\]/)
  assert.match(prompt, /worker: Worker Agent/)
  assert.match(prompt, /researcher: Research Agent/)
  assert.doesNotMatch(prompt, /reviewer: Review Agent/)
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

test('phase 3A child-run setting round-trips and remains an escape hatch', () => {
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
  assert.equal(settings.enableChildRuns, true)
  assert.equal(settings.maxTurns, 8)
})

test('external delegation writes are unsupported while queries remain available', async () => {
  const store = freshStore()
  await assert.rejects(
    () => dispatchCommand('delegation.create', {}, { store }),
    /unsupported|Runtime 内部/,
  )
  await assert.rejects(
    () => dispatchCommand('delegation.update', {}, { store }),
    /unsupported|Runtime 内部/,
  )
  await assert.rejects(
    () => dispatchCommand('delegation.attach_child_run', {}, { store }),
    /unsupported|Runtime 内部/,
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

test('agent toggle and delegation cancel use constrained command paths', async () => {
  const store = freshStore()
  const toggled = await dispatchCommand(
    'agent.set_enabled',
    { agentId: 'reviewer', enabled: false },
    { store },
  )
  assert.equal(toggled.agent.enabled, false)
  assert.equal(store.agents.get('reviewer').enabled, false)

  const calls = []
  const cancelled = await dispatchCommand(
    'delegation.cancel',
    { delegationId: 'delegation-1' },
    {
      store,
      agent: {
        cancelDelegation: (delegationId) => {
          calls.push(delegationId)
          return { accepted: true }
        },
      },
    },
  )
  assert.deepEqual(calls, ['delegation-1'])
  assert.deepEqual(cancelled, { accepted: true })
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
  const read = await dispatchCommand(
    'workspace.read_file',
    { projectId: project.id, path: 'a.txt' },
    ctx,
  )
  const saved = await dispatchCommand(
    'workspace.write_file',
    {
      projectId: project.id,
      path: 'a.txt',
      content: 'hello!\n',
      readToken: read.readToken,
    },
    ctx,
  )
  assert.equal(
    calls.find((call) => call.method === 'file.read').params
      .preserveLineEndings,
    true,
  )
  const write = calls.find((call) => call.method === 'file.write').params
  assert.deepEqual(write.revision, revision)
  assert.equal(write.source, 'ui')
  assert.equal('grant' in write, false)
  // 连续保存：写响应的新凭据回登记，第二次保存必须携带它。
  await dispatchCommand(
    'workspace.write_file',
    {
      projectId: project.id,
      path: 'a.txt',
      content: 'hello?\n',
      readToken: saved.readToken,
    },
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
  const read = await dispatchCommand(
    'workspace.read_file',
    { projectId: project.id, path: 'big.txt', offset: 0, limit: 10 },
    ctx,
  )
  await assert.rejects(
    () =>
      dispatchCommand(
        'workspace.write_file',
        {
          projectId: project.id,
          path: 'big.txt',
          content: 'stomp\n',
          readToken: read.readToken,
        },
        ctx,
      ),
    /分页窗口/,
  )
  assert.equal(
    calls.some((call) => call.method === 'file.write'),
    false,
  )
})

test('workspace.git_stage forwards paths and serializes mutations per workspace', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const system = {
    available: true,
    request: async (method, params, options) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      // 第一个请求挂起：第二个必须排队，直到 release 才允许开始。
      if (calls.length === 1) await gate
      return { ok: true }
    },
  }
  const first = dispatchCommand(
    'workspace.git_stage',
    { projectId: project.id, paths: ['src/a.ts', 'b.txt'] },
    { store, system },
  )
  const second = dispatchCommand(
    'workspace.git_unstage',
    { projectId: project.id, paths: ['c.txt'] },
    { store, system },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, '第二个命令不得先于第一个完成而启动')
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true },
    { ok: true },
  ])
  assert.deepEqual(
    calls.map((call) => call.method),
    ['git.stage', 'git.unstage'],
  )
  assert.deepEqual(calls[0].params, {
    workspaceRoot: '/workspace',
    paths: ['src/a.ts', 'b.txt'],
  })
  assert.deepEqual(calls[1].params, {
    workspaceRoot: '/workspace',
    paths: ['c.txt'],
  })
  // 外层 35s > Rust 内层 30s（GIT_LOCAL_WRITE），失败信息以 Rust 侧为准。
  assert.equal(calls[0].timeoutMs, 35_000)
})

test('workspace.git_commit rejects empty message and git_fetch raises timeout', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const system = {
    available: true,
    request: async (method, params, options) => {
      calls.push({ method, timeoutMs: options?.timeoutMs })
      return { ok: true }
    },
  }
  await assert.rejects(
    () =>
      dispatchCommand(
        'workspace.git_commit',
        { projectId: project.id, message: '' },
        { store, system },
      ),
    (error) => error.code === 'invalid_request',
  )
  assert.deepEqual(calls, [])
  await dispatchCommand(
    'workspace.git_commit',
    { projectId: project.id, message: 'feat: x' },
    { store, system },
  )
  await dispatchCommand(
    'workspace.git_fetch',
    { projectId: project.id },
    { store, system },
  )
  assert.deepEqual(calls, [
    { method: 'git.commit', timeoutMs: 35_000 },
    { method: 'git.fetch', timeoutMs: 130_000 },
  ])
})

test('workspace.git_status passes through branch context and defaults to null', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const full = {
    repo: true,
    entries: [{ path: 'a.ts', status: 'M', staged: true }],
    truncated: false,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
  }
  const result = await dispatchCommand(
    'workspace.git_status',
    { projectId: project.id },
    {
      store,
      system: { available: true, request: async () => full },
    },
  )
  assert.deepEqual(result, full)
  const bare = await dispatchCommand(
    'workspace.git_status',
    { projectId: project.id },
    {
      store,
      system: { available: true, request: async () => ({ repo: false }) },
    },
  )
  assert.deepEqual(bare, {
    repo: false,
    entries: [],
    truncated: false,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
  })
})

test('workspace.agent_changes returns deduplicated latest root task changes', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'completed',
  })
  const tool = store.toolCalls.create({
    runId: run.id,
    messageId: message.id,
    toolName: 'file.write',
    args: {},
  })
  store.mutationReceipts.record({
    rootRunId: run.id,
    runId: run.id,
    delegationId: null,
    agentInstanceId: null,
    toolCallId: tool.id,
    toolName: 'file.write',
    output: {
      type: 'tool_output',
      version: 1,
      content: 'ok',
      data: null,
      resourceLinks: [],
      changedFiles: [
        { path: 'src/a.ts', action: 'created' },
        { path: 'src/a.ts', action: 'modified' },
      ],
      provenance: null,
    },
  })
  const result = await dispatchCommand(
    'workspace.agent_changes',
    { projectId: project.id, sessionId: session.id },
    { store },
  )
  assert.deepEqual(result, {
    rootRunId: run.id,
    changes: [{ path: 'src/a.ts', action: 'modified' }],
  })
})

test('workspace.git_log forwards clamped paging and defaults empty fields', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const commits = [
    {
      hash: 'deadbeef',
      shortHash: 'deadbee',
      timestampMs: 1_700_000_000_000,
      authorName: 'me',
      isMerge: false,
      subject: 'feat: history',
    },
  ]
  const result = await dispatchCommand(
    'workspace.git_log',
    { projectId: project.id, skip: -3, limit: 0 },
    {
      store,
      system: {
        available: true,
        request: async (method, params) => {
          calls.push({ method, params })
          return { repo: true, commits, hasMore: true }
        },
      },
    },
  )
  // skip 负值收敛到 0，limit 下限 1（与 list_dir 同一约定）。
  assert.deepEqual(calls, [
    {
      method: 'git.log',
      params: { workspaceRoot: '/workspace', skip: 0, limit: 1 },
    },
  ])
  assert.deepEqual(result, { repo: true, commits, hasMore: true })
  const bare = await dispatchCommand(
    'workspace.git_log',
    { projectId: project.id },
    {
      store,
      system: { available: true, request: async () => ({ repo: false }) },
    },
  )
  assert.deepEqual(bare, { repo: false, commits: [], hasMore: false })
})

test('workspace.git_commit_files rejects malformed hash before calling Rust', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const system = {
    available: true,
    request: async (method, params) => {
      calls.push({ method, params })
      return { files: [{ path: 'a.ts', status: 'M' }] }
    },
  }
  for (const hash of ['HEAD;rm', 'zzz', 'abc']) {
    await assert.rejects(
      () =>
        dispatchCommand(
          'workspace.git_commit_files',
          { projectId: project.id, hash },
          { store, system },
        ),
      (error) => error.code === 'invalid_request',
    )
  }
  assert.deepEqual(calls, [])
  const result = await dispatchCommand(
    'workspace.git_commit_files',
    { projectId: project.id, hash: 'deadbeef' },
    { store, system },
  )
  assert.deepEqual(result, { files: [{ path: 'a.ts', status: 'M' }] })
  assert.deepEqual(calls, [
    {
      method: 'git.commit_files',
      params: { workspaceRoot: '/workspace', hash: 'deadbeef' },
    },
  ])
})

test('workspace.git_commit_diff validates hash and relative path, forwards both sides', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const system = {
    available: true,
    request: async (method, params) => {
      calls.push({ method, params })
      return {
        original: 'old',
        modified: 'new',
        binary: false,
        truncated: false,
      }
    },
  }
  await assert.rejects(
    () =>
      dispatchCommand(
        'workspace.git_commit_diff',
        { projectId: project.id, hash: 'nothex', path: 'a.ts' },
        { store, system },
      ),
    (error) => error.code === 'invalid_request',
  )
  await assert.rejects(
    () =>
      dispatchCommand(
        'workspace.git_commit_diff',
        { projectId: project.id, hash: 'deadbeef', path: '../secret' },
        { store, system },
      ),
    (error) => error.code === 'invalid_request',
  )
  assert.deepEqual(calls, [])
  const result = await dispatchCommand(
    'workspace.git_commit_diff',
    { projectId: project.id, hash: 'deadbeef', path: 'src/a.ts' },
    { store, system },
  )
  assert.deepEqual(calls, [
    {
      method: 'git.commit_diff',
      params: {
        workspaceRoot: '/workspace',
        hash: 'deadbeef',
        path: 'src/a.ts',
      },
    },
  ])
  assert.deepEqual(result, {
    original: 'old',
    modified: 'new',
    binary: false,
    truncated: false,
  })
  const empty = await dispatchCommand(
    'workspace.git_commit_diff',
    { projectId: project.id, hash: 'deadbeef', path: 'src/a.ts' },
    { store, system: { available: true, request: async () => ({}) } },
  )
  assert.deepEqual(empty, {
    original: '',
    modified: '',
    binary: false,
    truncated: false,
  })
})

test('workspace.git_branch_create forwards optional startRef only when provided', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const system = {
    available: true,
    request: async (method, params) => {
      calls.push({ method, params })
      return { ok: true }
    },
  }
  await dispatchCommand(
    'workspace.git_branch_create',
    { projectId: project.id, name: 'feature', startRef: 'abc123' },
    { store, system },
  )
  await dispatchCommand(
    'workspace.git_branch_create',
    { projectId: project.id, name: 'plain' },
    { store, system },
  )
  assert.equal(calls[0].params.startRef, 'abc123')
  assert.equal('startRef' in calls[1].params, false)
})

test('workspace.git_branches passes through remoteBranches and defaults to empty', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const full = await dispatchCommand(
    'workspace.git_branches',
    { projectId: project.id },
    {
      store,
      system: {
        available: true,
        request: async () => ({
          repo: true,
          current: 'main',
          branches: ['main'],
          remoteBranches: ['origin/main', 'origin/dev'],
        }),
      },
    },
  )
  assert.deepEqual(full, {
    repo: true,
    current: 'main',
    branches: ['main'],
    remoteBranches: ['origin/main', 'origin/dev'],
  })
  const bare = await dispatchCommand(
    'workspace.git_branches',
    { projectId: project.id },
    {
      store,
      system: { available: true, request: async () => ({ repo: false }) },
    },
  )
  assert.deepEqual(bare, {
    repo: false,
    current: null,
    branches: [],
    remoteBranches: [],
  })
})

test('workspace.git_remotes forwards root and defaults repo/remotes when empty', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  const remotes = [{ name: 'origin', url: 'https://***@example.com/a/b.git' }]
  const result = await dispatchCommand(
    'workspace.git_remotes',
    { projectId: project.id },
    {
      store,
      system: {
        available: true,
        request: async (method, params) => {
          calls.push({ method, params })
          return { repo: true, remotes }
        },
      },
    },
  )
  assert.deepEqual(calls, [
    { method: 'git.remotes', params: { workspaceRoot: '/workspace' } },
  ])
  assert.deepEqual(result, { repo: true, remotes })
  const bare = await dispatchCommand(
    'workspace.git_remotes',
    { projectId: project.id },
    { store, system: { available: true, request: async () => ({}) } },
  )
  assert.deepEqual(bare, { repo: false, remotes: [] })
})

test('workspace.git_remote_add validates params, forwards url untouched, queues per workspace', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/workspace' })
  const calls = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const system = {
    available: true,
    request: async (method, params, options) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      // 第一个请求挂起：第二个必须排队，直到 release 才允许开始。
      if (calls.length === 1) await gate
      return { ok: true }
    },
  }
  // name/url 缺失或为空在任何 Rust 调用之前拒绝。
  for (const params of [
    { projectId: project.id, url: 'https://example.com/a.git' },
    { projectId: project.id, name: 'origin' },
    { projectId: project.id, name: '', url: 'https://example.com/a.git' },
  ]) {
    await assert.rejects(
      () =>
        dispatchCommand('workspace.git_remote_add', params, { store, system }),
      (error) => error.code === 'invalid_request',
    )
  }
  assert.deepEqual(calls, [])
  // 非法 URL runtime 侧不拦截（URL 形状校验归 Rust），原样转发。
  const first = dispatchCommand(
    'workspace.git_remote_add',
    { projectId: project.id, name: 'origin', url: 'ext::sh -c whoami' },
    { store, system },
  )
  const second = dispatchCommand(
    'workspace.git_remote_remove',
    { projectId: project.id, name: 'old' },
    { store, system },
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, '第二个命令不得先于第一个完成而启动')
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true },
    { ok: true },
  ])
  assert.deepEqual(
    calls.map((call) => call.method),
    ['git.remote_add', 'git.remote_remove'],
  )
  assert.deepEqual(calls[0].params, {
    workspaceRoot: '/workspace',
    name: 'origin',
    url: 'ext::sh -c whoami',
  })
  assert.deepEqual(calls[1].params, {
    workspaceRoot: '/workspace',
    name: 'old',
  })
  // 本地 config 写：外层 35s > Rust 内层 30s。
  assert.equal(calls[0].timeoutMs, 35_000)
  assert.equal(calls[1].timeoutMs, 35_000)
})

test('project paths preserve Windows drive/UNC and POSIX roots', () => {
  for (const [input, platform, expected] of [
    ['C:\\', 'win32', 'C:\\'],
    ['C:/', 'win32', 'C:\\'],
    ['C:', 'win32', 'C:\\'],
    ['\\\\server\\share\\', 'win32', '\\\\server\\share\\'],
    ['C:\\工作 目录\\', 'win32', 'C:\\工作 目录'],
    ['/', 'linux', '/'],
    ['/tmp/work/', 'darwin', '/tmp/work'],
    ['/tmp/name\\', 'linux', '/tmp/name\\'],
    ['', 'win32', ''],
  ]) {
    assert.equal(normalizeProjectFolderPath(input, platform), expected)
  }
})

test('project.create retains the native filesystem root', async () => {
  const store = freshStore()
  const root = parse(process.cwd()).root
  const result = await dispatchCommand(
    'project.create',
    { folderPath: root },
    { store },
  )
  assert.equal(result.project.folderPath, root)
  assert.equal(store.projects.get(result.project.id).folderPath, root)
})

test('workspace snapshot tokens isolate preview reads and bind exact paths', async () => {
  const store = freshStore()
  const root = mkdtempSync(join(tmpdir(), 'reflexion-snapshots-'))
  const project = store.projects.create({ name: 'p', folderPath: root })
  const oldRevision = { modifiedMs: 1, sizeBytes: 6, sha256: 'a'.repeat(64) }
  let revision = oldRevision
  let complete = true
  const writes = []
  const ctx = {
    store,
    system: {
      available: true,
      request: async (method, params) => {
        if (method === 'file.read')
          return {
            content: 'hello\n',
            sizeBytes: 6,
            totalLines: 1,
            offset: 0,
            readComplete: complete,
            revision,
          }
        writes.push(params)
        return { writtenBytes: 6, revision }
      },
    },
  }
  const params = { projectId: project.id, path: 'a.txt' }
  const editor = await dispatchCommand('workspace.read_file', params, ctx)
  revision = { ...revision, modifiedMs: 2 }
  await dispatchCommand('workspace.read_file', params, ctx)
  complete = false
  await dispatchCommand('workspace.read_file', params, ctx)
  await dispatchCommand(
    'workspace.write_file',
    { ...params, content: 'draft', readToken: editor.readToken },
    ctx,
  )
  assert.deepEqual(writes[0].revision, oldRevision)
  for (const extra of [{ path: 'other.txt' }, { readToken: 'unknown' }]) {
    await assert.rejects(
      () =>
        dispatchCommand(
          'workspace.write_file',
          {
            ...params,
            content: 'draft',
            readToken: editor.readToken,
            ...extra,
          },
          ctx,
        ),
      /读取快照/,
    )
  }
  assert.equal(writes.length, 1)
})
