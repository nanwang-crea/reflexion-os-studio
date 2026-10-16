import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentTeamShareSchema } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { exportTeam, importTeam } from '../dist/agent/templates/team-share.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'team-share-'))
  const store = new Store(root)
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const project = store.projects.create({ name: 'Project', folderPath: root })
  const role = {
    name: 'Writer',
    description: 'Write',
    systemPrompt: 'Use evidence.',
    domains: ['team:writing', '写作'],
    modelBinding: { mode: 'inherit' },
    enabled: true,
    permissionCeiling: 'workspace-read',
    allowedTools: ['file.read'],
    canDelegate: false,
  }
  const a = store.agents.saveUser({ ...role, projectId: project.id })
  const b = store.agents.saveUser({
    ...role,
    name: 'Reviewer',
    enabled: false,
    projectId: project.id,
  })
  const global = store.agents.saveUser({ ...role, projectId: null })
  return { root, store, project, a, b, global }
}

test('team export defaults to all members including disabled roles in the exact scope; supports subset', async (t) => {
  const f = await fixture(t)
  const params = {
    requestId: randomUUID(),
    teamId: 'writing',
    projectId: f.project.id,
    directory: f.root,
  }
  const result = await exportTeam(params, f.store)
  assert.equal(result.roleCount, 2)
  const archive = AgentTeamShareSchema.parse(
    JSON.parse(await readFile(result.path, 'utf8')),
  )
  assert.deepEqual(archive.roles.map((role) => role.name).sort(), [
    'Reviewer',
    'Writer',
  ])
  assert.deepEqual(archive.roles[0].domains, ['写作'])
  for (const role of archive.roles) {
    for (const key of ['id', 'projectId', 'modelBinding', 'enabled'])
      assert.equal(Object.hasOwn(role, key), false)
  }
  const subset = await exportTeam({ ...params, templateIds: [f.a.id] }, f.store)
  assert.equal(subset.roleCount, 1)
  assert.notEqual(subset.path, result.path)
  await assert.rejects(
    exportTeam({ ...params, templateIds: [f.global.id] }, f.store),
    /不属于该团队/,
  )
  await assert.rejects(exportTeam({ ...params, templateIds: [] }, f.store))
  await assert.rejects(
    exportTeam({ ...params, teamId: 'missing' }, f.store),
    /没有可导出/,
  )
})

test('team import creates disabled roles atomically and isolates conflicting team identities', async (t) => {
  const f = await fixture(t)
  const result = await exportTeam(
    {
      requestId: randomUUID(),
      teamId: 'writing',
      projectId: f.project.id,
      directory: f.root,
    },
    f.store,
  )
  const archive = AgentTeamShareSchema.parse(
    JSON.parse(await readFile(result.path, 'utf8')),
  )
  const imported = importTeam(
    { requestId: randomUUID(), archive, projectId: f.project.id },
    f.store,
  )
  assert.notEqual(imported.teamId, 'writing')
  assert.equal(imported.templates.length, 2)
  for (const role of imported.templates) {
    assert.equal(role.enabled, false)
    assert.deepEqual(role.modelBinding, { mode: 'inherit' })
    assert.deepEqual(role.domains, ['写作', `team:${imported.teamId}`])
    assert.equal(role.projectId, f.project.id)
    assert.ok(![f.a.id, f.b.id].includes(role.id))
  }
  const before = f.store.agents.list().length
  assert.throws(
    () =>
      importTeam(
        { requestId: randomUUID(), archive, projectId: 'missing' },
        f.store,
      ),
    /未保存任何角色/,
  )
  const invalid = {
    ...archive,
    roles: [
      archive.roles[0],
      {
        ...archive.roles[1],
        domains: Array.from({ length: 12 }, (_, i) => `领域${i}`),
      },
    ],
  }
  assert.throws(
    () =>
      importTeam(
        { requestId: randomUUID(), archive: invalid, projectId: null },
        f.store,
      ),
    /未保存任何角色/,
  )
  assert.equal(f.store.agents.list().length, before)
  assert.equal(f.store.agents.get(f.a.id).enabled, true)
})
