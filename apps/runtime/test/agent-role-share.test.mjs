import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRoleShareSchema } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { exportRole } from '../dist/agent/templates/share.js'

const input = {
  name: '共享评审',
  description: '检查实现',
  systemPrompt: '检查证据并提出建议。',
  enabled: true,
  allowedTools: ['file.read'],
  canDelegate: false,
  permissionCeiling: 'workspace-read',
  domains: ['开发'],
}

test('role export is portable, non-destructive and can create a new role', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'role-share-'))
  const store = new Store(root)
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const role = store.agents.saveUser(input)
  const first = await exportRole(store, role.id, root)
  const second = await exportRole(store, role.id, root)
  assert.notEqual(first.path, second.path)
  const text = await readFile(first.path, 'utf8')
  const shared = AgentRoleShareSchema.parse(JSON.parse(text))
  assert.equal(shared.role.systemPrompt, input.systemPrompt)
  assert.equal(shared.role.name, input.name)
  for (const key of ['id', 'projectId', 'modelBinding', 'builtin', 'enabled'])
    assert.equal(Object.hasOwn(shared.role, key), false)
  const copy = store.agents.saveUser({
    ...shared.role,
    projectId: null,
    modelBinding: { mode: 'inherit' },
    enabled: false,
  })
  assert.notEqual(copy.id, role.id)
  assert.equal(copy.enabled, false)
  assert.equal(store.agents.get(role.id).enabled, true)
  await assert.rejects(exportRole(store, role.id, 'relative'), /普通目录/)
  await assert.rejects(exportRole(store, 'missing', root), /角色不存在/)
})

test('share format rejects unsupported versions, identity injection and invalid fields', () => {
  const role = { ...input }
  delete role.enabled
  const file = { format: 'reflexion-role', version: 1, role }
  assert.equal(AgentRoleShareSchema.safeParse(file).success, true)
  for (const invalid of [
    { ...file, version: 2 },
    { ...file, role: { ...role, id: 'overwrite' } },
    { ...file, role: { ...role, modelBinding: { mode: 'inherit' } } },
    { ...file, role: { ...role, systemPrompt: '' } },
    { ...file, role: { ...role, permissionCeiling: 'root' } },
  ])
    assert.equal(AgentRoleShareSchema.safeParse(invalid).success, false)
})
