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

for (const mode of [
  'image-only-preserved',
  'explicit-removal',
  'empty-rejected',
  'invalid-replacement',
]) {
  test(`edit resend image semantics: ${mode}`, (t) => {
    const f = fixture(t)
    const image = {
      type: 'image',
      assetId: 'stored-image',
      mimeType: 'image/png',
    }
    f.store.messages.finalize(f.user.id, f.user.content, 'completed', '', [
      { type: 'text', text: f.user.content },
      image,
    ])
    const params = {
      requestId: mode,
      sessionId: f.session.id,
      messageId: f.user.id,
      content:
        mode === 'explicit-removal' || mode === 'invalid-replacement'
          ? 'edited question'
          : '',
      ...(mode === 'empty-rejected' || mode === 'explicit-removal'
        ? { imageAssetIds: [] }
        : mode === 'invalid-replacement'
          ? { imageAssetIds: ['missing-image'] }
          : {}),
    }
    if (mode === 'empty-rejected' || mode === 'invalid-replacement') {
      assert.throws(
        () => f.agent.startEditResend(params),
        mode === 'empty-rejected' ? /不能为空/ : /图片不存在/,
      )
      assert.equal(f.launches.length, 0)
      assert.equal(
        f.store.messages
          .listBySession(f.session.id, true)
          .find((message) => message.id === f.user.id).status,
        'completed',
      )
      assert.equal(f.store.runs.get(f.original.id).supersededByRunId, null)
      assert.equal(f.store.runs.listBySession(f.session.id).length, 1)
    } else {
      f.agent.startEditResend(params)
      const user = f.store.messages
        .listBySession(f.session.id)
        .find((message) => message.role === 'user')
      assert.deepEqual(
        user.parts,
        mode === 'image-only-preserved'
          ? [image]
          : [{ type: 'text', text: 'edited question' }],
      )
      assert.deepEqual(
        f.store.messages
          .listBySession(f.session.id, true)
          .find((message) => message.id === f.user.id)
          .parts.at(-1),
        image,
        'superseded history keeps its images',
      )
    }
  })
}

test('edit resend replaces images with validated session assets', (t) => {
  const f = fixture(t)
  const originalImage = {
    type: 'image',
    assetId: 'stored-image',
    mimeType: 'image/png',
  }
  f.store.messages.finalize(f.user.id, f.user.content, 'completed', '', [
    { type: 'text', text: f.user.content },
    originalImage,
  ])
  f.store.assetStore.create({
    assetId: 'replacement-image',
    projectId: null,
    sessionId: f.session.id,
    uri: 'asset://replacement-image',
    kind: 'image',
    mimeType: 'image/png',
    size: 1,
    hash: 'test-image-hash',
    fileName: 'replacement.png',
    runId: null,
    nodeRunId: null,
    createdBy: 'user',
    createdAt: new Date().toISOString(),
    metadata: {},
    preview: 'ready',
  })
  f.agent.startEditResend({
    requestId: 'replace-image',
    sessionId: f.session.id,
    messageId: f.user.id,
    content: 'new image',
    imageAssetIds: ['replacement-image'],
  })
  const user = f.store.messages
    .listBySession(f.session.id)
    .find((message) => message.role === 'user')
  assert.deepEqual(user.parts, [
    { type: 'text', text: 'new image' },
    { type: 'image', assetId: 'replacement-image', mimeType: 'image/png' },
  ])
  assert.deepEqual(
    f.store.messages
      .listBySession(f.session.id, true)
      .find((message) => message.id === f.user.id)
      .parts.at(-1),
    originalImage,
  )
})

for (const mode of ['preserve', 'replace', 'remove']) {
  test(`document edit resend retains canonical extraction: ${mode}`, async (t) => {
    const f = fixture(t)
    const { AssetService } = await import('../dist/assets/service.js')
    const { userContentParts } =
      await import('../dist/agent/context/image-parts.js')
    const assets = new AssetService(f.store, f.store.dataDir)
    const upload = (name) =>
      assets.uploadDocument({
        sessionId: f.session.id,
        fileName: name,
        base64: Buffer.from(name).toString('base64'),
      })
    const first = await upload('first.ts')
    const second = await upload('second.txt')
    f.store.messages.finalize(
      f.user.id,
      f.user.content,
      'completed',
      '',
      userContentParts(f.store, f.session.id, f.user.content, [first.assetId]),
    )
    f.agent.startEditResend({
      requestId: 'edit-file',
      sessionId: f.session.id,
      messageId: f.user.id,
      content: 'revised',
      ...(mode === 'preserve'
        ? {}
        : { attachmentAssetIds: mode === 'remove' ? [] : [second.assetId] }),
    })
    const user = f.store.messages
      .listBySession(f.session.id)
      .find((message) => message.role === 'user')
    const files = user.parts.filter((part) => part.type === 'file')
    assert.deepEqual(
      files.map((part) => part.assetId),
      mode === 'remove'
        ? []
        : [mode === 'preserve' ? first.assetId : second.assetId],
    )
    if (files.length)
      assert.match(files[0].extraction.text, /1: (first.ts|second.txt)/)
    const run = f.store.runs.activeForSession(f.session.id)
    f.store.runs.finalize(run.id, 'failed')
    f.agent.startRetry({ requestId: 'retry-file', runId: run.id })
    assert.deepEqual(
      f.store.messages
        .listBySession(f.session.id)
        .find((message) => message.role === 'user').parts,
      user.parts,
    )
  })
}

test('queued documents survive text edits and are validated again when sent', async (t) => {
  const f = fixture(t)
  const { AssetService } = await import('../dist/assets/service.js')
  const assets = new AssetService(f.store, f.store.dataDir)
  const file = await assets.uploadDocument({
    sessionId: f.session.id,
    fileName: 'queued.txt',
    base64: Buffer.from('queued contents').toString('base64'),
  })
  const active = f.store.runs.create({
    sessionId: f.session.id,
    providerId: f.providers[0].id,
    model: 'old-model',
  })
  const queued = f.agent.send({
    requestId: 'queue-file',
    sessionId: f.session.id,
    content: 'analyze',
    attachmentAssetIds: [file.assetId],
  })
  assert.equal(queued.queued, true)
  const edited = f.agent.updateQueue(f.session.id, queued.queueId, 'updated')
  assert.deepEqual(edited.item.attachmentAssetIds, [file.assetId])
  f.store.runs.finalize(active.id, 'completed')
  f.agent.pumpQueue(f.session.id)
  const user = f.store.messages
    .listBySession(f.session.id)
    .filter((message) => message.role === 'user')
    .at(-1)
  assert.equal(user.content, 'updated')
  assert.equal(user.parts[1].assetId, file.assetId)
  assert.equal(user.parts[1].extraction.text, '1: queued contents')
})
