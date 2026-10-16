import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture, input } from './fixtures/skill-packages.mjs'
import { dispatchCommand } from '../dist/handlers.js'
import { roleSkillsSnapshot } from '../dist/agent/templates/skills.js'

const role = {
  name: 'Report editor',
  description: 'Reports',
  systemPrompt: 'Review the report.',
  enabled: true,
  allowedTools: ['skill.use', 'file.read'],
  canDelegate: false,
  permissionCeiling: 'workspace-read',
}

test('role bindings persist, snapshot startup instructions, and preserve tool policy', async (t) => {
  const f = fixture(t)
  await f.service.save(input(f.project.id))
  const { template } = await dispatchCommand(
    'agent_template.save',
    {
      ...role,
      requestId: randomUUID(),
      projectId: f.project.id,
      skills: [{ skillId: 'example-helper', mode: 'startup' }],
    },
    { store: f.store, plugins: f.service },
  )
  assert.deepEqual(f.store.agents.get(template.id).skills, template.skills)
  const snapshot = roleSkillsSnapshot(
    template,
    f.service.registry,
    f.project.id,
  )
  assert.match(snapshot.instructions, /scripts\/report.mjs/)
  assert.equal(snapshot.skills[0].version, '1.0.0')
  assert.deepEqual(template.policy.allowedTools, role.allowedTools)
  const preferred = roleSkillsSnapshot(
    { ...template, skills: [{ skillId: 'example-helper', mode: 'preferred' }] },
    f.service.registry,
    f.project.id,
  )
  assert.match(preferred.instructions, /先调用 skill.use/)
  assert.doesNotMatch(preferred.instructions, /write report.txt/)
  f.service.toggle('example-helper', false)
  assert.throws(
    () => roleSkillsSnapshot(template, f.service.registry, f.project.id),
    /不可用/,
  )
})

test('save rejects inaccessible skills, duplicate bindings and preferred skill without tool', async (t) => {
  const f = fixture(t)
  await f.service.save(input(f.project.id))
  const binding = { skillId: 'example-helper', mode: 'preferred' }
  for (const patch of [
    { projectId: null, skills: [binding] },
    { projectId: f.project.id, skills: [binding, binding] },
    { projectId: f.project.id, skills: [binding], allowedTools: ['file.read'] },
    {
      projectId: f.project.id,
      skills: [{ skillId: 'missing', mode: 'startup' }],
    },
  ]) {
    await assert.rejects(
      dispatchCommand(
        'agent_template.save',
        {
          ...role,
          requestId: randomUUID(),
          ...patch,
        },
        { store: f.store, plugins: f.service },
      ),
    )
  }
  const plain = f.store.agents.saveUser(role)
  assert.deepEqual(plain.skills, [])
})

test('bulk scope and permission changes cannot invalidate existing skill bindings', async (t) => {
  const f = fixture(t)
  await f.service.save(input(f.project.id))
  const template = f.store.agents.saveUser({
    ...role,
    projectId: f.project.id,
    skills: [{ skillId: 'example-helper', mode: 'preferred' }],
  })
  for (const patch of [{ projectId: null }, { allowedTools: ['file.read'] }]) {
    await assert.rejects(
      dispatchCommand(
        'agent_template.bulk_update',
        {
          requestId: randomUUID(),
          targets: [{ id: template.id, updatedAt: template.updatedAt }],
          patch,
        },
        { store: f.store, plugins: f.service },
      ),
    )
    assert.equal(f.store.agents.get(template.id).projectId, f.project.id)
    assert.deepEqual(
      f.store.agents.get(template.id).policy.allowedTools,
      role.allowedTools,
    )
  }
})
