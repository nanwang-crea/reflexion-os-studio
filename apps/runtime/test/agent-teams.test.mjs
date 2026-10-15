import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Store } from '../dist/store/index.js'
import { createSkillRegistry } from '../dist/skills/index.js'
import { SkillPluginService } from '../dist/skills/service.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { createTeamCreateTool } from '../dist/agent/tools/team/create.js'
import { createTeamInspectTool } from '../dist/agent/tools/team/inspect.js'
import { teamApprovalReview } from '../dist/agent/tools/team/review.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunEventEmitter } from '../dist/events.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'
import { buildApprovalSubject } from '../dist/agent/permissions/subjects.js'
import { buildApprovalChoices } from '../dist/agent/permissions/choices.js'

const role = {
  name: 'Writer',
  description: 'Draft from evidence',
  systemPrompt:
    'Input: verified outline. Output: draft and references. Hand off to editor. Verify every claim.',
  enabled: true,
  allowedTools: ['file.read', 'file.write', 'skill.use'],
  canDelegate: false,
  domains: ['写作'],
}
const input = {
  teamId: 'writing',
  scope: 'project',
  roles: [
    role,
    { ...role, name: 'Editor', allowedTools: ['file.read', 'skill.use'] },
  ],
}
function fixture(t, projectScope = true) {
  const root = mkdtempSync(join(tmpdir(), 'agent-teams-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const project = store.projects.create({
    name: 'Project',
    folderPath: join(root, 'workspace'),
  })
  const session = store.sessions.create(projectScope ? project.id : null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'fixture',
  })
  const ctx = {
    store,
    sessionId: session.id,
    runId: run.id,
    messageId: 'fixture',
    projectId: projectScope ? project.id : null,
    workspaceRoot: projectScope ? project.folderPath : null,
    skills: createSkillRegistry(),
    system: null,
    mcp: null,
    emitter: new RunEventEmitter(run.id, () => {}),
    interactions: {},
  }
  return { root, store, project, session, run, ctx }
}
function invoke(ctx, args = input) {
  return createTeamCreateTool(ctx).execute({
    args,
    signal: new AbortController().signal,
  })
}
function gate(mode = 'execute', preset = 'workspace-full') {
  return new PermissionGate({
    preset,
    hasWorkspace: false,
    approvalOverride: 'default',
    dangerActive: () => true,
    executionMode: () => mode,
  })
}

test('both skill registries expose creation and upgraded collaboration methods', (t) => {
  const f = fixture(t)
  const service = new SkillPluginService(f.store, f.root, () => {})
  for (const registry of [f.ctx.skills, service.registry]) {
    assert.ok(registry.get('team-create'))
    assert.equal(registry.get('agent-collaboration').manifest.version, '1.1.1')
    assert.ok(
      registry.get('team-create').instructions.includes('agent_team.create'),
    )
  }
  const withoutDomains = structuredClone(input)
  delete withoutDomains.roles[0].domains
  const admission = createToolRegistry(f.ctx).validateRequest({
    id: 'schema-defaults',
    name: 'agent_team.create',
    arguments: JSON.stringify(withoutDomains),
  })
  assert.equal(admission.ok, true)
  const preview = teamApprovalReview({
    ...input,
    roles: [
      {
        ...role,
        modelBinding: {
          mode: 'fixed',
          providerId: 'fixture-provider',
          model: 'very-long-readable-model-name-for-real-configurations',
        },
      },
    ],
  })
  assert.equal(JSON.parse(preview).roles[0].modelBinding.mode, 'fixed')
})

test('team creation persists real role templates atomically and inspect isolates scope and credentials', (t) => {
  const f = fixture(t)
  const result = invoke(f.ctx)
  assert.equal(result.data.templates.length, 2)
  for (const template of result.data.templates) {
    assert.equal(template.projectId, f.project.id)
    assert.equal(template.policy.permissionCeiling, 'workspace-read')
    assert.deepEqual(template.modelBinding, { mode: 'inherit' })
    assert.ok(template.domains.includes('team:writing'))
  }
  assert.throws(() => invoke(f.ctx), /团队已存在/)
  const other = f.store.projects.create({
    name: 'Other',
    folderPath: join(f.root, 'other'),
  })
  f.store.agents.saveUser({ ...role, projectId: other.id })
  const profile = f.store.providers.upsert({
    id: 'fixture-provider',
    name: 'Fixture',
    enabled: true,
    models: ['fixture-model'],
    baseUrl: 'https://example.invalid',
    secretRef: 'synthetic-reference-not-exposed',
    headers: { 'X-Fixture': 'synthetic-header-not-exposed' },
    capabilities: ['chat'],
  })
  f.store.providerModels.upsert({
    providerId: profile.id,
    model: 'fixture-model',
    reasoningEffortSupported: true,
    reasoningEffort: 'high',
  })
  const inspected = createTeamInspectTool(f.ctx).execute({ args: {} })
  assert.equal(inspected.data.teams[0].teamId, 'writing')
  assert.ok(
    inspected.data.templates.every(
      (role) => role.projectId === null || role.projectId === f.project.id,
    ),
  )
  assert.equal(inspected.data.models[0].reasoningEffortSupported, true)
  assert.deepEqual(inspected.data.delegationLimits, f.store.agentSettings.get())
  assert.ok(inspected.data.delegatableTools.includes('file.write'))
  assert.ok(!inspected.data.delegatableTools.includes('agent_team.create'))
  const specific = createTeamInspectTool(f.ctx).execute({
    args: { templateId: result.data.templates[1].id },
  })
  assert.equal(specific.data.templates.length, 1)
  assert.equal(specific.data.templates[0].name, 'Editor')
  assert.ok(!inspected.content.includes('synthetic-reference-not-exposed'))
  assert.ok(!inspected.content.includes('synthetic-header-not-exposed'))
  const fixed = invoke(f.ctx, {
    ...input,
    teamId: 'fixed-writing',
    roles: [
      {
        ...role,
        modelBinding: {
          mode: 'fixed',
          providerId: profile.id,
          model: 'fixture-model',
          reasoningEffort: 'high',
        },
      },
    ],
  })
  assert.equal(fixed.data.templates[0].modelBinding.reasoningEffort, 'high')
  const reopened = new Store(f.root)
  try {
    assert.equal(
      reopened.agents.get(result.data.templates[0].id).name,
      'Writer',
    )
  } finally {
    reopened.close()
  }
})

test('invalid models, capabilities, metadata and failed inserts leave no partial team', (t) => {
  const f = fixture(t)
  const before = f.store.agents.list().length
  for (const bad of [
    {
      ...role,
      modelBinding: { mode: 'fixed', providerId: 'missing', model: 'missing' },
    },
    { ...role, allowedTools: ['agent_team.create'] },
    { ...role, domains: ['team:other'] },
    { ...role, canDelegate: true },
    { ...role, systemPrompt: 'token=synthetic-credential-fixture' },
    { ...role, projectId: 'foreign-project' },
  ]) {
    assert.throws(() =>
      invoke(f.ctx, { ...input, roles: [role, { ...bad, name: 'Other' }] }),
    )
    assert.equal(f.store.agents.list().length, before)
  }
  assert.throws(
    () =>
      invoke(f.ctx, {
        ...input,
        roles: [role, { ...role, name: '  Writer  ' }],
      }),
    /名称必须唯一/,
  )
  const original = f.store.agents.saveUser.bind(f.store.agents)
  let calls = 0
  f.store.agents.saveUser = (role) => {
    if (++calls === 2) throw Error('insert failed')
    return original(role)
  }
  assert.throws(() => invoke(f.ctx), /insert failed/)
  f.store.agents.saveUser = original
  assert.equal(f.store.agents.list().length, before)
})

test('no project and plan modes fail closed; administration is unavailable to children', (t) => {
  const f = fixture(t, false)
  assert.throws(() => invoke(f.ctx), /没有项目/)
  assert.equal(
    invoke(f.ctx, { ...input, scope: 'global' }).data.projectId,
    null,
  )
  f.store.sessions.setExecutionMode(f.session.id, 'plan')
  assert.throws(
    () => invoke(f.ctx, { ...input, teamId: 'other', scope: 'global' }),
    /计划模式/,
  )
  const child = f.store.runs.create({
    sessionId: f.session.id,
    providerId: 'fixture',
    model: 'fixture',
    parentRunId: f.run.id,
  })
  const childCtx = { ...f.ctx, runId: child.id }
  assert.throws(() => invoke(childCtx), /主 Agent/)
  assert.throws(
    () => createTeamInspectTool(childCtx).execute({ args: {} }),
    /主 Agent/,
  )
  const names = createToolRegistry(childCtx)
    .specs()
    .map((tool) => tool.name)
  assert.ok(!names.some((name) => name.startsWith('agent_team.')))
  assert.ok(
    createToolRegistry(f.ctx)
      .specs()
      .some((tool) => tool.name === 'agent_team.create'),
  )
})

test('saving needs exact one-time approval even with Danger, and cannot execute in plan mode', () => {
  const request = {
    toolName: 'agent_team.create',
    ...buildApprovalSubject('agent_team.create', input),
    escalation: false,
  }
  for (const preset of ['workspace-read', 'workspace-write', 'workspace-full'])
    assert.equal(gate('execute', preset).decisionFor(request), 'ask')
  assert.equal(gate('plan').decisionFor(request), 'denied')
  assert.equal(
    gate('plan').decisionFor({
      toolName: 'agent_team.inspect',
      ...buildApprovalSubject('agent_team.inspect', {}),
      escalation: false,
    }),
    'automatic',
  )
  const choices = buildApprovalChoices({
    toolName: request.toolName,
    subject: request.subject,
    sandbox: 'read-only',
    network: false,
    escalation: false,
    scope: { sessionId: 'fixture', workspaceRoot: null },
  })
  assert.deepEqual(
    choices.map((item) => item.choice.id),
    ['allow-once', 'deny'],
  )
  assert.notEqual(
    request.digest,
    buildApprovalSubject('agent_team.create', { ...input, teamId: 'different' })
      .digest,
  )
})

for (const choice of ['allow-once', 'deny'])
  test(`real agent loop ${choice} records canonical team output without bypassing approval`, async (t) => {
    const f = fixture(t, false)
    const approvals = new ApprovalGateway()
    const events = []
    const emitter = new RunEventEmitter(f.run.id, (event) => {
      events.push(event)
      if (event.type === 'approval.required')
        queueMicrotask(() => approvals.resolveChoice(event.toolCallId, choice))
    })
    const registry = createToolRegistry({ ...f.ctx, emitter })
    let turn = 0,
      observed = false
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const delta =
        ++turn === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'team-call',
                  type: 'function',
                  function: {
                    name: 'agent_team.create',
                    arguments: JSON.stringify({ ...input, scope: 'global' }),
                  },
                },
              ],
            }
          : { content: 'Completed.' }
      if (turn === 2)
        observed = JSON.stringify(body.messages).includes(
          choice === 'allow-once' ? 'team:writing' : '拒绝',
        )
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const assistant = f.store.messages.create({
        sessionId: f.session.id,
        runId: f.run.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      })
      await new RunRunner(f.store).execute({
        run: f.run,
        provider: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'synthetic-fixture',
          model: 'fixture',
          maxRetries: 0,
        },
        buildHistory: async () => [
          { role: 'user', content: 'Create a writing team.' },
        ],
        registry,
        workspaceRoot: null,
        gate: gate(),
        approvals,
        settings: { maxTurns: 3 },
        controller: new AbortController(),
        emitter,
        firstAssistantMessage: assistant,
      })
      const team = f.store.agents
        .list()
        .filter((role) => role.domains.includes('team:writing'))
      assert.equal(team.length, choice === 'allow-once' ? 2 : 0)
      assert.equal(
        events.filter((event) => event.type === 'approval.required').length,
        1,
      )
      const approval = events.find(
        (event) => event.type === 'approval.required',
      )
      assert.equal(JSON.parse(approval.context.review).roles[1].name, 'Editor')
      assert.equal(approval.choices.length, 2)
      const [call] = f.store.toolCalls.listByRun(f.run.id)
      assert.equal(
        call.status,
        choice === 'allow-once' ? 'completed' : 'failed',
      )
      if (choice === 'allow-once')
        assert.equal(call.output.data.templates.length, 2)
      assert.equal(observed, true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
