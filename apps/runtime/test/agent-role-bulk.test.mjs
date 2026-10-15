import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'role-bulk-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const roles = [0, 1].map((index) =>
    store.agents.saveUser({
      name: `Role ${index}`,
      description: 'Review',
      systemPrompt: `Keep instruction ${index}`,
      domains: [`team-${index}`],
      enabled: true,
      projectId: null,
      modelBinding: { mode: 'inherit' },
      permissionCeiling: 'workspace-read',
      allowedTools: index ? ['file.list', 'task'] : ['file.read'],
      canDelegate: index === 1,
    }),
  )
  const update = (patch, targets = roles) =>
    dispatchCommand(
      'agent_template.bulk_update',
      {
        requestId: randomUUID(),
        targets: targets.map(({ id, updatedAt }) => ({ id, updatedAt })),
        patch,
      },
      { store },
    )
  return { store, roles, update, root }
}

test('bulk scope changes preserve each role policy, instructions, domains and binding', async (t) => {
  const { store, roles, update, root } = fixture(t)
  const project = store.projects.create({
    name: 'Target',
    folderPath: join(root, 'target'),
  })
  const result = await update({ projectId: project.id })
  assert.equal(result.templates.length, 2)
  for (const before of roles) {
    const after = store.agents.get(before.id)
    assert.equal(after.projectId, project.id)
    assert.equal(after.source, 'project')
    assert.deepEqual(after.policy, before.policy)
    for (const key of [
      'systemPrompt',
      'domains',
      'modelBinding',
      'name',
      'enabled',
    ])
      assert.deepEqual(after[key], before[key])
  }
})

test('bulk permissions, tool replacement and delegation are saved consistently', async (t) => {
  const { store, roles, update } = fixture(t)
  await update({
    permissionCeiling: 'workspace-write',
    allowedTools: ['file.write', 'task'],
    canDelegate: false,
    enabled: false,
  })
  for (const role of roles) {
    const after = store.agents.get(role.id)
    assert.deepEqual(after.policy.allowedTools, ['file.write'])
    assert.equal(after.policy.permissionCeiling, 'workspace-write')
    assert.equal(after.policy.canDelegate, false)
    assert.equal(after.enabled, false)
  }
})

test('a missing, builtin or changed target rejects the entire batch', async (t) => {
  const { store, roles, update } = fixture(t)
  for (const targets of [
    [...roles, { id: 'missing', updatedAt: 'old' }],
    [{ ...roles[0], updatedAt: 'stale' }, roles[1]],
  ]) {
    await assert.rejects(update({ enabled: false }, targets))
    assert.ok(roles.every((role) => store.agents.get(role.id).enabled))
  }
  const builtin = store.agents.list().find((role) => role.builtin)
  assert.ok(builtin)
  await assert.rejects(update({ enabled: false }, [...roles, builtin]), /内置/)
  assert.ok(roles.every((role) => store.agents.get(role.id).enabled))
})

test('bulk errors roll back earlier writes and reject invalid or empty patches', async (t) => {
  const { store, roles, update } = fixture(t)
  await assert.rejects(update({ projectId: 'unknown' }), /项目不存在/)
  await assert.rejects(update({}))
  await assert.rejects(update({ enabled: false }, [roles[0], roles[0]]))
  const save = store.agents.saveUser.bind(store.agents)
  let count = 0
  store.agents.saveUser = (input) => {
    if (++count === 2) throw new Error('Synthetic write failure')
    return save(input)
  }
  try {
    await assert.rejects(update({ enabled: false }), /Synthetic write failure/)
  } finally {
    store.agents.saveUser = save
  }
  assert.ok(roles.every((role) => store.agents.get(role.id).enabled))
})
