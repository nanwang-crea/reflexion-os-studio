import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { createTeamCreateTool } from '../dist/agent/tools/team/create.js'
import { createTeamMutationTool } from '../dist/agent/tools/team/mutate.js'
import { createTeamInspectTool } from '../dist/agent/tools/team/inspect.js'
import { teamApprovalReview } from '../dist/agent/tools/team/review.js'
import { buildApprovalSubject } from '../dist/agent/permissions/subjects.js'
import { buildApprovalChoices } from '../dist/agent/permissions/choices.js'
import { PermissionGate } from '../dist/agent/permissions/index.js'

const role = {
  name: 'Writer',
  description: 'Write from outline',
  systemPrompt: 'Draft and verify sources.',
  enabled: true,
  allowedTools: ['file.read', 'file.write'],
  canDelegate: false,
  domains: ['writing'],
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-mutations-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const project = store.projects.create({
    name: 'Project',
    folderPath: join(root, 'workspace'),
  })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'fixture',
  })
  const ctx = {
    store,
    projectId: project.id,
    sessionId: session.id,
    runId: run.id,
    mcp: null,
  }
  const call = (tool, args) =>
    tool.execute({ args, signal: new AbortController().signal })
  const created = call(createTeamCreateTool(ctx), {
    teamId: 'writing',
    scope: 'project',
    roles: [role, { ...role, name: 'Editor' }],
  }).data.templates
  const target = () => ({
    teamId: 'writing',
    scope: 'project',
    expectedRevision: createTeamInspectTool(ctx)
      .execute({ args: { teamId: 'writing' } })
      .data.teams.find((team) => team.projectId === project.id).revision,
  })
  const mutate = (operation, args) =>
    call(createTeamMutationTool(ctx, operation), args)
  return { root, store, ctx, project, session, created, target, mutate }
}

test('incremental additions preserve members; updates retain identity and persist; stale requests cannot overwrite', (t) => {
  const f = fixture(t)
  const stale = f.target()
  const preview = JSON.parse(
    teamApprovalReview(
      { ...stale, roles: [{ ...role, name: 'Outline architect' }] },
      'agent_team.update',
      f.ctx,
    ),
  )
  assert.equal(preview.roles[0].permissionCeiling, 'workspace-read')
  assert.deepEqual(preview.roles[0].modelBinding, { mode: 'inherit' })
  assert.deepEqual(preview.roles[0].domains, ['writing', 'team:writing'])
  const result = f.mutate('update', {
    ...stale,
    roles: [{ ...role, name: 'Outline architect' }],
  })
  assert.equal(result.data.templates.length, 1)
  assert.equal(
    f.store.agents
      .list(f.project.id)
      .filter((r) => r.domains.includes('team:writing')).length,
    3,
  )
  assert.equal(
    f.store.agents.get(f.created[0].id).systemPrompt,
    role.systemPrompt,
  )
  assert.throws(() => f.mutate('delete', stale), /配置已变化/)
  const id = f.created[0].id
  f.mutate('update', {
    ...f.target(),
    roles: [
      { ...role, id, name: 'Author', permissionCeiling: 'workspace-write' },
    ],
  })
  assert.equal(
    f.store.agents.get(id).policy.permissionCeiling,
    'workspace-write',
  )
  const reopened = new Store(f.root)
  try {
    assert.equal(reopened.agents.get(id).name, 'Author')
  } finally {
    reopened.close()
  }
  const snapshot = f.target()
  f.store.agents.setEnabled(id, false)
  assert.throws(
    () => f.mutate('update', { ...snapshot, removeRoleIds: [id] }),
    /配置已变化/,
  )
  assert.ok(f.store.agents.get(id))
})

test('invalid and foreign members, duplicate names, unknown tools and failed writes leave the entire team intact', (t) => {
  const f = fixture(t)
  const other = f.store.projects.create({
    name: 'Other',
    folderPath: join(f.root, 'other'),
  })
  const foreign = f.store.agents.saveUser({ ...role, projectId: other.id })
  const baseline = f.store.agents.list()
  for (const changes of [
    { roles: [{ ...role, id: foreign.id }] },
    { removeRoleIds: [foreign.id] },
    { roles: [{ ...role, id: 'researcher' }] },
    { roles: [role] },
    { roles: [{ ...role, name: 'New', allowedTools: ['agent_team.delete'] }] },
    {
      roles: [
        {
          ...role,
          name: 'New',
          modelBinding: {
            mode: 'fixed',
            providerId: 'missing',
            model: 'missing',
          },
        },
      ],
    },
    {
      roles: [{ ...role, id: f.created[0].id }],
      removeRoleIds: [f.created[0].id],
    },
    {},
  ]) {
    assert.throws(() => f.mutate('update', { ...f.target(), ...changes }))
    assert.deepEqual(f.store.agents.list(), baseline)
  }
  const original = f.store.agents.saveUser.bind(f.store.agents)
  f.store.agents.saveUser = () => {
    throw new Error('write failed')
  }
  assert.throws(
    () =>
      f.mutate('update', {
        ...f.target(),
        removeRoleIds: [f.created[0].id],
        roles: [{ ...role, name: 'New' }],
      }),
    /write failed/,
  )
  f.store.agents.saveUser = original
  assert.deepEqual(f.store.agents.list(), baseline)
})

test('explicit removal deletes exclusive templates; deleting a team retains shared roles and other scopes', (t) => {
  const f = fixture(t)
  const shared = f.created[0]
  f.store.agents.saveUser({
    ...role,
    id: shared.id,
    projectId: f.project.id,
    domains: ['team:writing', 'team:other'],
  })
  const global = f.store.agents.saveUser({
    ...role,
    projectId: null,
    domains: ['team:writing'],
  })
  const preview = JSON.parse(
    teamApprovalReview(f.target(), 'agent_team.delete', f.ctx),
  )
  assert.ok(preview.currentMembers.some((member) => member.id === shared.id))
  const removed = f.mutate('update', {
    ...f.target(),
    removeRoleIds: [f.created[1].id],
  })
  assert.equal(removed.data.removed[0].action, 'deleted')
  assert.equal(f.store.agents.get(f.created[1].id), null)
  const targetBeforeDelete = f.target()
  const deleted = f.mutate('delete', targetBeforeDelete)
  assert.equal(deleted.data.deleted, true)
  assert.equal(deleted.data.removed[0].action, 'detached')
  assert.deepEqual(f.store.agents.get(shared.id).domains, ['team:other'])
  assert.ok(f.store.agents.get(global.id))
  assert.throws(() => f.mutate('delete', targetBeforeDelete), /团队不存在/)
})

for (const operation of ['update', 'delete'])
  test(`${operation} requires exact one-time approval and denies children and plan mode`, (t) => {
    const f = fixture(t)
    const name = `agent_team.${operation}`
    const args = {
      ...f.target(),
      ...(operation === 'update' ? { roles: [{ ...role, name: 'New' }] } : {}),
    }
    const built = buildApprovalSubject(name, args)
    const gate = new PermissionGate({
      preset: 'workspace-full',
      hasWorkspace: true,
      approvalOverride: 'default',
      dangerActive: () => true,
    })
    assert.equal(
      gate.decisionFor({
        toolName: name,
        subject: built.subject,
        escalation: false,
      }),
      'ask',
    )
    const choices = buildApprovalChoices({
      toolName: name,
      subject: built.subject,
      sandbox: 'workspace-write',
      network: false,
      escalation: false,
      scope: { sessionId: f.session.id, workspaceRoot: null },
    })
    assert.deepEqual(
      choices.map((item) => item.choice.id),
      ['allow-once', 'deny'],
    )
    assert.notEqual(
      built.digest,
      buildApprovalSubject(name, { ...args, expectedRevision: '0'.repeat(64) })
        .digest,
    )
    f.store.sessions.setExecutionMode(f.session.id, 'plan')
    assert.throws(() => f.mutate(operation, args), /计划模式/)
    f.store.sessions.setExecutionMode(f.session.id, 'execute')
    const child = f.store.runs.create({
      sessionId: f.session.id,
      providerId: 'fixture',
      model: 'fixture',
      parentRunId: f.ctx.runId,
    })
    assert.throws(
      () =>
        createTeamMutationTool(
          { ...f.ctx, runId: child.id },
          operation,
        ).execute({ args, signal: new AbortController().signal }),
      /主 Agent/,
    )
    const controller = new AbortController()
    controller.abort()
    assert.throws(
      () =>
        createTeamMutationTool(f.ctx, operation).execute({
          args,
          signal: controller.signal,
        }),
      /Aborted/,
    )
  })
