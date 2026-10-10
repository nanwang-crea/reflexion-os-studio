import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { saveSecret } from '../dist/secrets.js'
import { ChatAgent } from '../dist/agent/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'

function fixture(t) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'resubmission-')))
  const agent = new ChatAgent(store, () => {}, null)
  t.after(() => {
    agent.dispose()
    store.close()
  })
  const launches = []
  agent.launch = (input) => launches.push(input)
  const providers = ['old', 'new'].map((name) =>
    store.providers.upsert({
      name,
      baseUrl: 'https://example.invalid',
      models: [`${name}-model`],
      secretRef: saveSecret('synthetic-test-value'),
      enabled: true,
    }),
  )
  const session = store.sessions.create(null)
  const original = store.runs.create({
    sessionId: session.id,
    providerId: providers[0].id,
    model: 'old-model',
  })
  const user = store.messages.create({
    sessionId: session.id,
    runId: original.id,
    role: 'user',
    content: 'original question',
    status: 'completed',
  })
  store.runs.finalize(original.id, 'failed')
  return { store, agent, launches, providers, session, original, user }
}

for (const mode of [
  'same-provider',
  'different-provider',
  'legacy',
  'provider-only',
]) {
  test(`retry selects model and persists it: ${mode}`, async (t) => {
    const f = fixture(t)
    const overrides =
      mode === 'legacy'
        ? {}
        : mode === 'same-provider'
          ? { providerId: f.providers[0].id, model: 'switched-model' }
          : {
              providerId: f.providers[1].id,
              ...(mode === 'provider-only' ? {} : { model: 'new-model' }),
            }
    const params = CommandSchemaRegistry['run.retry'].params.parse({
      requestId: 'retry-test',
      runId: f.original.id,
      ...overrides,
    })
    const result = await dispatchCommand('run.retry', params, {
      agent: f.agent,
      store: f.store,
    })
    const expectedProvider =
      mode === 'legacy' || mode === 'same-provider'
        ? f.providers[0].id
        : f.providers[1].id
    const expectedModel =
      mode === 'legacy'
        ? 'old-model'
        : mode === 'same-provider'
          ? 'switched-model'
          : 'new-model'
    const run = f.store.runs.get(result.runId)
    assert.equal(run.providerId, expectedProvider)
    assert.equal(run.model, expectedModel)
    assert.equal(f.launches[0].profile.id, expectedProvider)
    assert.equal(f.launches[0].model, expectedModel)
    assert.equal(f.launches[0].permissionPreset, 'workspace-read')
    assert.equal(run.retryOfRunId, f.original.id)
    assert.equal(f.store.runs.get(f.original.id).model, 'old-model')
  })
}

test('edit resend uses current provider and model', async (t) => {
  const f = fixture(t)
  const params = CommandSchemaRegistry['message.edit_resend'].params.parse({
    requestId: 'edit-test',
    sessionId: f.session.id,
    messageId: f.user.id,
    content: 'edited question',
    providerId: f.providers[1].id,
    model: 'new-model',
  })
  const result = await dispatchCommand('message.edit_resend', params, {
    agent: f.agent,
    store: f.store,
  })
  assert.equal(f.store.runs.get(result.runId).providerId, f.providers[1].id)
  assert.equal(f.store.runs.get(result.runId).model, 'new-model')
  assert.equal(f.launches[0].model, 'new-model')
  assert.equal(f.launches[0].profile.id, f.providers[1].id)
})

test('image references survive retry and editing without copying image bytes', (t) => {
  const f = fixture(t)
  const parts = [
    { type: 'text', text: f.user.content },
    { type: 'image', assetId: 'stored-image', mimeType: 'image/png' },
  ]
  f.store.messages.finalize(f.user.id, f.user.content, 'completed', '', parts)
  f.agent.startRetry({ requestId: 'retry-image', runId: f.original.id })
  assert.deepEqual(
    f.store.messages
      .listBySession(f.session.id)
      .find((message) => message.role === 'user').parts,
    parts,
  )
  const active = f.store.runs.activeForSession(f.session.id)
  f.store.runs.finalize(active.id, 'failed')
  f.agent.startEditResend({
    requestId: 'edit-image',
    sessionId: f.session.id,
    messageId: f.user.id,
    content: 'revised question',
  })
  const user = f.store.messages
    .listBySession(f.session.id)
    .find((message) => message.role === 'user')
  assert.equal(user.content, 'revised question')
  assert.deepEqual(user.parts, [
    { type: 'text', text: 'revised question' },
    parts[1],
  ])
})
