import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateWorkflowResources } from '../../dist/workflow/execution/resources.js'
import { harness } from './harness.mjs'

const fingerprint = { modifiedMs: 1, sizeBytes: 5, sha256: 'a'.repeat(64) }
const value = (projectId, path = 'sample.txt', revision = fingerprint) => ({
  file: {
    type: 'resource',
    value: { kind: 'workspaceFile', projectId, path, revision },
  },
})

test('resource identity is checked and credential paths are refused before any read', async (t) => {
  const h = harness(t)
  let calls = 0
  const deps = {
    store: h.store,
    assets: {},
    system: {
      available: true,
      async request() {
        calls++
        return { revision: fingerprint }
      },
    },
  }
  await validateWorkflowResources(deps, h.project.id, value(h.project.id))
  assert.equal(calls, 1)
  await assert.rejects(
    validateWorkflowResources(
      deps,
      h.project.id,
      value(h.project.id, '.env.production'),
    ),
    /resource_denied/,
  )
  await assert.rejects(
    validateWorkflowResources(
      deps,
      h.project.id,
      value(h.project.id, 'C:\\private.txt'),
    ),
  )
  await assert.rejects(
    validateWorkflowResources(deps, h.project.id, value('other')),
  )
  assert.equal(calls, 1)
  await assert.rejects(
    validateWorkflowResources(
      deps,
      h.project.id,
      value(h.project.id, 'sample.txt', {
        ...fingerprint,
        sha256: 'b'.repeat(64),
      }),
    ),
    /resource_stale/,
  )
})

test('portable resource paths reject Windows aliases before any system read', async (t) => {
  const h = harness(t)
  const requests = []
  const deps = {
    store: h.store,
    assets: {},
    system: {
      available: true,
      async request(_method, params) {
        requests.push(params.path)
        return { revision: fingerprint }
      },
    },
  }
  for (const path of [
    'docs/secrets.json:preview',
    'docs/credentials.json.',
    'docs/.ssh /note.txt',
    'NUL.txt',
    'aux/readme.txt',
    'COM1',
    'LPT².log',
    'CONOUT$',
    'docs/a\u0000.txt',
    'docs/a?.txt',
    '\\\\server\\share\\note.txt',
    '\\\\?\\C:\\note.txt',
    'C:note.txt',
  ]) {
    await assert.rejects(
      validateWorkflowResources(deps, h.project.id, value(h.project.id, path)),
      undefined,
      path,
    )
  }
  assert.deepEqual(requests, [])
  for (const path of [
    'docs\\设计.txt',
    'docs/设计.txt',
    'docs/COM10.txt',
    './docs/设计.txt',
  ]) {
    await validateWorkflowResources(
      deps,
      h.project.id,
      value(h.project.id, path),
    )
  }
  assert.deepEqual(requests, [
    'docs/设计.txt',
    'docs/设计.txt',
    'docs/COM10.txt',
    './docs/设计.txt',
  ])
})

test('Asset ownership and metadata hash are checked before touching content', async (t) => {
  const h = harness(t)
  const assetId = 'fixture-resource'
  h.store.assetStore.create({
    assetId,
    projectId: h.project.id,
    uri: `asset://${assetId}`,
    kind: 'text',
    mimeType: 'text/plain',
    size: 5,
    hash: 'a'.repeat(64),
    fileName: 'sample.txt',
    runId: null,
    nodeRunId: null,
    createdBy: 'user',
    createdAt: new Date().toISOString(),
    metadata: {},
    preview: 'ready',
  })
  let reads = 0
  const deps = {
    store: h.store,
    system: null,
    assets: {
      async verifyHash() {
        reads++
        return true
      },
    },
  }
  const values = {
    asset: {
      type: 'resource',
      value: { kind: 'asset', assetId, hash: 'b'.repeat(64) },
    },
  }
  await assert.rejects(
    validateWorkflowResources(deps, h.project.id, values),
    /resource_stale/,
  )
  assert.equal(reads, 0)
  values.asset.value.hash = 'a'.repeat(64)
  await validateWorkflowResources(deps, h.project.id, values)
  assert.equal(reads, 1)
})
