import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture, input } from './fixtures/skill-packages.mjs'
import { dispatchCommand } from '../dist/handlers.js'

async function setup(t) {
  const f = fixture(t)
  await f.service.save(input())
  const roles = [0, 1].map((i) =>
    f.store.agents.saveUser({
      name: `Role ${i}`,
      description: 'Review',
      systemPrompt: 'Review evidence.',
      enabled: true,
      allowedTools: ['skill.use'],
      canDelegate: false,
      skills: [{ skillId: 'example-helper', mode: 'startup' }],
    }),
  )
  const targets = roles.map(({ id, updatedAt }) => ({ id, updatedAt }))
  const remove = (selection = targets) =>
    dispatchCommand(
      'agent_template.bulk_remove',
      { requestId: randomUUID(), targets: selection },
      { store: f.store },
    )
  return { ...f, roles, targets, remove }
}

test('bulk delete preserves delegation history, skill packages and other roles', async (t) => {
  const f = await setup(t)
  const other = f.store.agents.saveUser({
    ...f.roles[0],
    id: undefined,
    name: 'Other',
    permissionCeiling: 'workspace-read',
    allowedTools: ['skill.use'],
    canDelegate: false,
  })
  const session = f.store.sessions.create(f.project.id)
  const run = f.store.runs.create({
    sessionId: session.id,
    providerId: 'test',
    model: 'test',
  })
  const delegation = f.store.delegations.create({
    sessionId: session.id,
    parentRunId: run.id,
    agentId: f.roles[0].id,
    task: 'Review',
  })
  const result = await f.remove()
  assert.deepEqual(
    result.removedIds,
    f.targets.map((item) => item.id),
  )
  assert.ok(f.roles.every((role) => f.store.agents.get(role.id) === null))
  assert.ok(f.store.agents.get(other.id))
  assert.equal(f.store.delegations.listByParentRun(run.id)[0].id, delegation.id)
  assert.ok(f.store.plugins.get('example-helper'))
})

test('missing, stale, builtin, duplicate or empty targets never partially delete', async (t) => {
  const f = await setup(t)
  const builtin = f.store.agents.upsert({
    id: 'test-builtin',
    name: 'Builtin',
    description: '',
    systemPrompt: 'Read.',
    enabled: true,
  })
  for (const targets of [
    [],
    [f.targets[0], f.targets[0]],
    [f.targets[0], { id: 'missing', updatedAt: 'x' }],
    [f.targets[0], { ...f.targets[1], updatedAt: 'stale' }],
    [f.targets[0], { id: builtin.id, updatedAt: builtin.updatedAt }],
  ]) {
    await assert.rejects(f.remove(targets))
    assert.ok(f.roles.every((role) => f.store.agents.get(role.id)))
  }
})

test('an unexpected delete failure rolls back all prior deletions', async (t) => {
  const f = await setup(t)
  const original = f.store.agents.removeUser.bind(f.store.agents)
  let calls = 0
  f.store.agents.removeUser = (id) => (++calls === 2 ? false : original(id))
  await assert.rejects(f.remove(), /未删除任何角色/)
  assert.ok(f.roles.every((role) => f.store.agents.get(role.id)))
})
