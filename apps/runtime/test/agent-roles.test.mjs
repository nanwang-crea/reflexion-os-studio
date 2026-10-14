import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { Store } from '../dist/store/index.js'
import { dispatchCommand, commandHandlers } from '../dist/handlers.js'
import { createChildRunStarter } from '../dist/agent/delegation.js'
import { resolveRoleModel } from '../dist/agent/delegation/role-model.js'
import { resolveModelRuntimeConfig } from '../dist/agent/provider-resolver.js'
import { SkillPluginService } from '../dist/skills/service.js'
import { runtimeMethodNames } from '@reflexion-os-studio/contracts'

const role = {
  name: 'Reviewer',
  description: 'Independent review',
  systemPrompt: 'Review evidence.',
  enabled: true,
  allowedTools: ['file.read', 'file.write'],
  canDelegate: false,
  permissionCeiling: 'workspace-read',
  domains: ['开发', '写作'],
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-roles-'))
  let store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const project = store.projects.create({
    name: 'Project A',
    folderPath: join(root, 'workspace'),
  })
  const other = store.projects.create({
    name: 'Project B',
    folderPath: join(root, 'other'),
  })
  const profile = store.providers.upsert({
    id: 'role-provider',
    name: 'Synthetic',
    models: ['review-model'],
    baseUrl: 'https://example.invalid',
    enabled: true,
    secretRef: 'synthetic-reference',
    capabilities: ['chat'],
  })
  store.providerModels.upsert({
    providerId: profile.id,
    model: 'review-model',
    reasoningEffortSupported: true,
    reasoningEffort: 'high',
  })
  const reopen = () => {
    store.close()
    store = new Store(root)
    return store
  }
  return { store, project, other, profile, root, reopen }
}

test('retired Workflow commands are absent from contracts and runtime', () => {
  assert.equal(
    runtimeMethodNames.some((method) => method.startsWith('workflow.')),
    false,
  )
  assert.equal(
    Object.keys(commandHandlers).some((method) =>
      method.startsWith('workflow.'),
    ),
    false,
  )
})

test('roles persist scope, domains and model; project catalogs do not leak roles', async (t) => {
  const f = fixture(t)
  const saved = await dispatchCommand(
    'agent_template.save',
    {
      requestId: randomUUID(),
      ...role,
      projectId: f.project.id,
      modelBinding: {
        mode: 'fixed',
        providerId: f.profile.id,
        model: 'review-model',
        reasoningEffort: 'high',
      },
    },
    { store: f.store },
  )
  assert.equal(saved.template.source, 'project')
  assert.ok(
    f.store.agents
      .list(f.project.id)
      .some((item) => item.id === saved.template.id),
  )
  assert.equal(
    f.store.agents
      .list(f.other.id)
      .some((item) => item.id === saved.template.id),
    false,
  )
  assert.equal(
    f.store.agents.list(null).some((item) => item.id === saved.template.id),
    false,
  )
  const global = f.store.agents.saveUser({ ...role, projectId: null })
  assert.ok(
    f.store.agents.list(f.other.id).some((item) => item.id === global.id),
  )
  const reopened = f.reopen()
  assert.deepEqual(
    reopened.agents.get(saved.template.id).modelBinding,
    saved.template.modelBinding,
  )
  assert.deepEqual(reopened.agents.get(saved.template.id).domains, [
    '开发',
    '写作',
  ])
})

test('fixed model is resolved explicitly; unavailable configuration never falls back', (t) => {
  const f = fixture(t)
  const template = f.store.agents.saveUser({
    ...role,
    modelBinding: {
      mode: 'fixed',
      providerId: f.profile.id,
      model: 'review-model',
      reasoningEffort: 'high',
    },
  })
  const inherited = {
    profile: { ...f.profile, id: 'parent' },
    apiKey: 'synthetic',
    model: 'parent-model',
    sampling: {},
  }
  const calls = []
  const actual = resolveRoleModel(
    f.store,
    template,
    inherited,
    (store, providerId, model, effort) => {
      calls.push([providerId, model, effort])
      return {
        profile: resolveModelRuntimeConfig(
          f.profile,
          store.providerModels.get(providerId, model),
          effort,
        ),
        model,
        apiKey: 'synthetic',
      }
    },
  )
  assert.deepEqual(calls, [[f.profile.id, 'review-model', 'high']])
  assert.equal(actual.model, 'review-model')
  assert.equal(actual.profile.reasoningEffort, 'high')
  assert.throws(
    () =>
      resolveRoleModel(
        f.store,
        {
          ...template,
          modelBinding: {
            mode: 'fixed',
            providerId: f.profile.id,
            model: 'removed-model',
          },
        },
        inherited,
      ),
    /指定的模型不可用/,
  )
  assert.deepEqual(
    resolveRoleModel(
      f.store,
      { ...template, modelBinding: { mode: 'inherit' } },
      inherited,
    ),
    inherited,
  )
})

test('delegation preserves actual model/workspace and denies another project role', async (t) => {
  const f = fixture(t)
  const template = f.store.agents.saveUser({
    ...role,
    projectId: f.project.id,
    modelBinding: {
      mode: 'fixed',
      providerId: f.profile.id,
      model: 'review-model',
      reasoningEffort: 'high',
    },
  })
  const session = f.store.sessions.create(f.project.id)
  const parent = f.store.runs.create({
    sessionId: session.id,
    providerId: 'parent',
    model: 'parent-model',
  })
  let launched
  const deps = {
    store: f.store,
    notifier: () => {},
    profile: { ...f.profile, id: 'parent' },
    apiKey: 'synthetic',
    model: 'parent-model',
    sampling: {},
    resolveProvider: (store, providerId, model, effort) => ({
      profile: resolveModelRuntimeConfig(
        f.profile,
        store.providerModels.get(providerId, model),
        effort,
      ),
      apiKey: 'synthetic',
      model,
    }),
    launcher: {
      depthOf: () => 0,
      permissionPresetOf: () => 'workspace-full',
      launch(input) {
        launched = input
        input.onResult('Reviewed')
      },
    },
  }
  await createChildRunStarter(
    deps,
    parent,
    session,
  )({
    task: 'Review',
    agent: { templateId: template.id },
    signal: new AbortController().signal,
  })
  const [delegation] = f.store.delegations.listByParentRun(parent.id)
  assert.equal(launched.model, 'review-model')
  assert.equal(delegation.execution.model, 'review-model')
  assert.equal(delegation.execution.reasoningEffort, 'high')
  assert.equal(
    delegation.agentInstance.workspaceRoot,
    f.store.projects.get(f.project.id).folderPath,
  )
  assert.equal(delegation.agentInstance.permissionPreset, 'workspace-read')
  assert.equal(f.store.runs.get(delegation.childRunId).providerId, f.profile.id)
  const foreign = f.store.sessions.create(f.other.id)
  await assert.rejects(
    () =>
      createChildRunStarter(
        deps,
        parent,
        foreign,
      )({
        task: 'Review',
        agent: { templateId: template.id },
        signal: new AbortController().signal,
      }),
    /not found or disabled/,
  )
  assert.equal(f.store.delegations.listBySession(foreign.id).length, 0)
})

test('v46 migration preserves chat and legacy role defaults', (t) => {
  const f = fixture(t)
  const session = f.store.sessions.create(f.project.id, 'Keep history')
  const old = f.store.agents.saveUser(role)
  const db = new DatabaseSync(join(f.root, 'reflexion.db'))
  db.exec(
    "UPDATE agents SET configuration_json = '{}'; PRAGMA user_version = 46",
  )
  db.close()
  const reopened = f.reopen()
  assert.equal(reopened.sessions.get(session.id).title, 'Keep history')
  assert.deepEqual(reopened.agents.get(old.id).modelBinding, {
    mode: 'inherit',
  })
  assert.ok(reopened.agents.list().some((item) => item.id === old.id))
})

test('reviewed collaboration Skills use the standard installer and survive restart with project scope', async (t) => {
  const f = fixture(t)
  const service = new SkillPluginService(f.store, f.root, () => {})
  const template = f.store.agents.saveUser({ ...role, projectId: f.project.id })
  const input = {
    id: 'reviewed-collaboration',
    projectId: f.project.id,
    description: 'Feature review collaboration',
    instructions: `# Method\n\nUse optional template ${template.id}; review evidence and verify completion.`,
    requestId: randomUUID(),
  }
  await assert.rejects(
    () => service.save({ ...input, id: 'wrong-scope-skill', projectId: null }),
    /角色所属项目/,
  )
  const customRole = f.store.agents.saveUser({
    ...role,
    id: 'custom-reviewer.v1',
    projectId: f.project.id,
  })
  for (const projectId of [null, f.other.id]) {
    await assert.rejects(
      () =>
        service.save({
          ...input,
          id: 'custom-role-wrong-scope',
          projectId,
          instructions: `Use template ${customRole.id}.`,
        }),
      /角色所属项目/,
    )
  }
  await service.save({
    ...input,
    id: 'custom-role-same-scope',
    instructions: `Use template ${customRole.id}.`,
  })
  await assert.rejects(
    () =>
      service.save({
        ...input,
        id: 'credential-shaped-content',
        instructions: `token=${template.id}`,
      }),
    /疑似包含机密/,
  )
  const saved = await service.save(input)
  assert.equal(saved.scope, 'project')
  assert.ok(service.registry.get(input.id, f.project.id))
  assert.equal(service.registry.get(input.id, f.other.id), null)
  await assert.rejects(() => service.save(input), /标识已存在/)
  const restarted = new SkillPluginService(f.reopen(), f.root, () => {})
  assert.ok(restarted.registry.get(input.id, f.project.id))
  assert.ok(restarted.registry.get('agent-collaboration', null))
})

test('ordinary chat delegates through the real loop to the role model and streams its result', async (t) => {
  const f = fixture(t)
  const { startServer, sseBody } =
    await import('./fixtures/provider-server.mjs')
  const { saveSecret } = await import('../dist/secrets.js')
  const { ChatAgent } = await import('../dist/agent/index.js')
  const requests = [],
    events = []
  const childServer = await startServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(sseBody())
    })
  })
  f.store.providers.upsert({
    ...f.profile,
    baseUrl: `http://127.0.0.1:${childServer.address().port}/v1`,
    secretRef: saveSecret('synthetic-role-value'),
  })
  const template = f.store.agents.saveUser({
    ...role,
    projectId: f.project.id,
    modelBinding: {
      mode: 'fixed',
      providerId: f.profile.id,
      model: 'review-model',
      reasoningEffort: 'high',
    },
  })
  let parentCalls = 0
  const parentServer = await startServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (parentCalls++ > 0) {
        response.end(sseBody())
        return
      }
      const delta = {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'review-call',
                  type: 'function',
                  function: {
                    name: 'task',
                    arguments: JSON.stringify({
                      task: 'Review independently',
                      templateId: template.id,
                    }),
                  },
                },
              ],
            },
          },
        ],
      }
      response.end(
        `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      )
    })
  })
  const parentProfile = f.store.providers.upsert({
    id: 'parent-provider',
    name: 'Parent',
    models: ['parent-model'],
    enabled: true,
    baseUrl: `http://127.0.0.1:${parentServer.address().port}/v1`,
    secretRef: saveSecret('synthetic-parent-value'),
    capabilities: ['chat'],
  })
  const agent = new ChatAgent(f.store, (event) => events.push(event), null)
  t.after(() => {
    agent.dispose()
    childServer.closeAllConnections()
    childServer.close()
    parentServer.closeAllConnections()
    parentServer.close()
  })
  const session = f.store.sessions.create(f.project.id, 'Delegation acceptance')
  const result = agent.send({
    requestId: randomUUID(),
    sessionId: session.id,
    content: '实现并审阅',
    providerId: parentProfile.id,
    model: 'parent-model',
    permissionPreset: 'workspace-read',
  })
  const deadline = Date.now() + 10000
  while (
    Date.now() < deadline &&
    !['completed', 'failed'].includes(f.store.runs.get(result.runId).status)
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  const root = f.store.runs.get(result.runId)
  assert.equal(root.status, 'completed')
  assert.equal(parentCalls, 2)
  assert.equal(
    requests.length,
    1,
    JSON.stringify(
      f.store.toolCalls.listByRun(root.id).map((call) => call.output),
    ),
  )
  assert.equal(requests[0].model, 'review-model')
  assert.equal(requests[0].reasoning_effort, 'high')
  const [delegation] = f.store.delegations.listByParentRun(root.id)
  assert.equal(delegation.status, 'completed')
  assert.equal(f.store.runs.get(delegation.childRunId).providerId, f.profile.id)
  assert.ok(
    events.some(
      (event) =>
        event.type === 'message.delta' && event.runId === delegation.childRunId,
    ),
  )
})
