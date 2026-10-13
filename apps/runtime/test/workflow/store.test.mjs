import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../dist/store/index.js'
import { LATEST_SCHEMA_VERSION } from '../../dist/store/schema.js'
import { saveWorkflowDefinition } from '../../dist/workflow/definitions/service.js'
import { workflowFixture } from '../../../../packages/contracts/test/fixtures/workflow.mjs'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-workflow-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const project = store.projects.create({ name: 'Synthetic', folderPath: dir })
  return {
    dir,
    store,
    project,
    input: {
      projectId: project.id,
      baseRevision: 0,
      definition: workflowFixture(),
      origin: 'manual',
    },
  }
}

test('versions are immutable and stale/concurrent saves fail atomically', (t) => {
  const { store, input, project } = setup(t)
  const v1 = saveWorkflowDefinition(store, input)
  input.definition.nodes[0].role.systemPrompt = 'Updated role'
  const v2 = saveWorkflowDefinition(store, {
    ...input,
    id: v1.definitionId,
    baseRevision: 1,
  })
  assert.equal(v2.revision, 2)
  assert.notEqual(
    store.workflows.get(project.id, v1.definitionId, 1).definition.nodes[0].role
      .systemPrompt,
    'Updated role',
  )
  assert.throws(
    () =>
      saveWorkflowDefinition(store, {
        ...input,
        id: v1.definitionId,
        baseRevision: 1,
      }),
    { code: 'workflow_revision_conflict' },
  )
  assert.equal(store.workflows.get(project.id, v1.definitionId).revision, 2)
  assert.equal(store.workflows.get(project.id, v1.definitionId, 3), null)
})

test('project scope, archive and deletion preserve proper boundaries', (t) => {
  const { store, input, project } = setup(t)
  const version = saveWorkflowDefinition(store, input)
  const other = store.projects.create({ name: 'Other', folderPath: 'other' })
  assert.equal(store.workflows.get(other.id, version.definitionId), null)
  assert.throws(
    () =>
      saveWorkflowDefinition(store, {
        ...input,
        projectId: other.id,
        id: version.definitionId,
        baseRevision: 1,
      }),
    { code: 'workflow_revision_conflict' },
  )
  assert.equal(
    store.workflows.archive(project.id, version.definitionId, 0),
    false,
  )
  assert.equal(
    store.workflows.archive(project.id, version.definitionId, 1),
    true,
  )
  assert.equal(store.workflows.list(project.id).length, 0)
  assert.equal(store.workflows.list(project.id, true).length, 1)
  assert.equal(
    store.workflows.get(project.id, version.definitionId, 1).revision,
    1,
  )
  assert.throws(
    () =>
      saveWorkflowDefinition(store, {
        ...input,
        id: version.definitionId,
        baseRevision: 1,
      }),
    { code: 'workflow_revision_conflict' },
  )
  store.projects.delete(project.id)
  assert.equal(store.workflows.get(project.id, version.definitionId), null)
})

test('invalid graph is not persisted and failed inserts roll back', (t) => {
  const { store, input, project } = setup(t)
  const invalid = structuredClone(input.definition)
  invalid.edges[0].from.nodeId = 'missing'
  assert.throws(
    () => saveWorkflowDefinition(store, { ...input, definition: invalid }),
    /Invalid workflow/,
  )
  assert.equal(store.workflows.list(project.id).length, 0)
  const first = saveWorkflowDefinition(store, input)
  assert.throws(() =>
    saveWorkflowDefinition(store, {
      ...input,
      id: first.definitionId,
      baseRevision: 1,
      origin: 'invalid',
    }),
  )
  assert.equal(store.workflows.get(project.id, first.definitionId).revision, 1)
})

test('v43 database upgrades additively and versions survive reopening', (t) => {
  const { dir, store, input, project } = setup(t)
  const version = saveWorkflowDefinition(store, input)
  // Preserve existing versions across reopening, then exercise real pre-W0 DDL.
  const session = store.sessions.create(project.id, 'Existing chat')
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.exec('PRAGMA user_version = 43')
  db.close()
  const reopened = new Store(dir)
  try {
    assert.equal(
      reopened.workflows.get(project.id, version.definitionId).revision,
      1,
    )
    assert.equal(reopened.sessions.get(session.id).title, 'Existing chat')
    const check = new DatabaseSync(join(dir, 'reflexion.db'))
    assert.equal(
      check.prepare('PRAGMA user_version').get().user_version,
      LATEST_SCHEMA_VERSION,
    )
    assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0)
    check.close()
  } finally {
    reopened.close()
  }
})

test('v43 database without workflow tables migrates and preserves chat', (t) => {
  const { dir, store, project } = setup(t)
  const session = store.sessions.create(project.id, 'Legacy chat')
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.exec(
    'DROP TABLE workflow_versions; DROP TABLE workflow_definitions; PRAGMA user_version = 43',
  )
  db.close()
  const reopened = new Store(dir)
  try {
    assert.equal(reopened.sessions.get(session.id).title, 'Legacy chat')
    const version = saveWorkflowDefinition(reopened, {
      projectId: project.id,
      baseRevision: 0,
      definition: workflowFixture(),
      origin: 'manual',
    })
    assert.equal(version.revision, 1)
  } finally {
    reopened.close()
  }
})

test('template selection freezes trusted metadata and later edits preserve the snapshot', (t) => {
  const { store, input, project } = setup(t)
  const template = store.agents.saveUser({
    name: 'Editor',
    description: '',
    systemPrompt: 'Original template',
    enabled: true,
    allowedTools: ['file.read', 'task'],
    canDelegate: true,
  })
  input.definition.nodes[0].role.templateId = template.id
  input.definition.nodes[0].role.systemPrompt = 'Untrusted client override'
  const first = saveWorkflowDefinition(store, input)
  const role = first.definition.nodes[0].role
  assert.equal(role.systemPrompt, 'Original template')
  assert.equal(role.policy.canDelegate, false)
  assert.deepEqual(role.policy.allowedTools, ['file.read'])
  store.agents.saveUser({
    id: template.id,
    name: 'Editor',
    description: '',
    systemPrompt: 'Updated template',
    enabled: true,
    allowedTools: ['file.read'],
    canDelegate: false,
  })
  const second = saveWorkflowDefinition(store, {
    ...input,
    id: first.definitionId,
    baseRevision: 1,
    definition: first.definition,
  })
  assert.equal(
    second.definition.nodes[0].role.systemPrompt,
    'Original template',
  )
  const updated = structuredClone(second.definition)
  updated.nodes[0].role.templateUpdatedAt = null
  const third = saveWorkflowDefinition(store, {
    ...input,
    id: first.definitionId,
    baseRevision: 2,
    definition: updated,
  })
  assert.equal(third.definition.nodes[0].role.systemPrompt, 'Updated template')
  assert.equal(
    store.workflows.get(project.id, first.definitionId, 1).definition.nodes[0]
      .role.systemPrompt,
    'Original template',
  )
})
