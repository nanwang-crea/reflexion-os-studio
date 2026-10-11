import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { SCHEMA } from '../dist/store/schema.js'
import {
  resolveProvider,
  resolveSampling,
} from '../dist/agent/provider-resolver.js'
import { providerModelCommandHandlers } from '../dist/provider/model-handlers.js'
import { ChatAgent } from '../dist/agent/index.js'
import { saveSecret } from '../dist/secrets.js'
import { streamChat } from '../dist/provider.js'
import { startServer } from './fixtures/provider-server.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'provider-models-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const profile = store.providers.upsert({
    name: 'Test',
    baseUrl: 'https://example.invalid',
    models: ['a', 'b'],
    secretRef: saveSecret('synthetic-model-test'),
    enabled: true,
    temperature: 0.7,
    maxTokens: 2048,
    contextWindow: 128000,
    contextBudget: 64000,
    reasoningEffort: 'medium',
  })
  return { store, profile }
}

test('model overrides persist, omitted values preserve, null values inherit, and deletion cascades', (t) => {
  const { store, profile } = fixture(t)
  const input = { providerId: profile.id, model: 'a' }
  const first = store.providerModels.upsert({
    ...input,
    temperature: 0,
    reasoningEffortSupported: true,
    reasoningEffort: 'high',
  })
  assert.equal(first.reasoningEffortSupported, true)
  const preserved = store.providerModels.upsert({ ...input, maxTokens: 4096 })
  assert.equal(preserved.temperature, 0)
  assert.equal(preserved.reasoningEffortSupported, true)
  assert.equal(preserved.reasoningEffort, 'high')
  const cleared = store.providerModels.upsert({
    ...input,
    temperature: null,
    reasoningEffortSupported: false,
  })
  assert.equal(cleared.temperature, null)
  assert.equal(cleared.reasoningEffortSupported, false)
  assert.equal(store.providerModels.list(profile.id).length, 1)
  const reopened = new Store(store.dataDir)
  assert.equal(reopened.providerModels.get(profile.id, 'a').maxTokens, 4096)
  assert.equal(reopened.providers.get(profile.id).reasoningEffort, 'medium')
  reopened.close()
  store.providers.delete(profile.id)
  assert.deepEqual(store.providerModels.list(profile.id), [])
})

test('resolution applies overrides to selected model and gates reasoning by capability', (t) => {
  const { store, profile } = fixture(t)
  store.providerModels.upsert({
    providerId: profile.id,
    model: 'a',
    temperature: 0,
    maxTokens: 8192,
    contextWindow: 256000,
    contextBudget: 96000,
    reasoningEffortSupported: true,
  })
  const a = resolveProvider(store, profile.id, 'a').profile
  assert.deepEqual(resolveSampling(a), { temperature: 0, maxTokens: 8192 })
  assert.equal(a.contextWindow, 256000)
  assert.equal(a.contextBudget, 96000)
  assert.equal(a.reasoningEffort, 'medium')
  const b = resolveProvider(store, profile.id, 'b').profile
  assert.deepEqual(resolveSampling(b), { temperature: 0.7, maxTokens: 2048 })
  assert.equal(b.reasoningEffort, null)
  assert.equal(store.providers.get(profile.id).temperature, 0.7)
  store.providers.upsert({ ...profile, apiFormat: 'anthropic' })
  assert.equal(
    resolveProvider(store, profile.id, 'a').profile.reasoningEffort,
    null,
  )
})

test('model commands reject unknown providers/models and support restoring inherited defaults', (t) => {
  const { store, profile } = fixture(t)
  const ctx = { store }
  const configure = providerModelCommandHandlers['provider.model.configure']
  assert.throws(
    () => configure({ requestId: 'x', providerId: 'missing', model: 'a' }, ctx),
    /不存在/,
  )
  assert.throws(
    () =>
      configure(
        { requestId: 'x', providerId: profile.id, model: 'missing' },
        ctx,
      ),
    /模型不在/,
  )
  configure(
    {
      requestId: 'x',
      providerId: profile.id,
      model: 'a',
      reasoningEffortSupported: true,
    },
    ctx,
  )
  assert.equal(
    providerModelCommandHandlers['provider.model.list'](
      { providerId: profile.id },
      ctx,
    ).models.length,
    1,
  )
  assert.deepEqual(
    providerModelCommandHandlers['provider.model.delete'](
      { providerId: profile.id, model: 'a' },
      ctx,
    ),
    { removed: true },
  )
  assert.equal(
    resolveProvider(store, profile.id, 'a').profile.reasoningEffort,
    null,
  )
})

test('v39 migration keeps provider defaults and creates model configuration storage', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-model-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.exec(SCHEMA.replace('  reasoning_effort TEXT,\n', ''))
  db.exec('DROP TABLE provider_models; PRAGMA user_version = 39')
  db.prepare(
    `INSERT INTO provider_profiles (id,name,base_url,models,secret_ref,enabled,temperature,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    'legacy',
    'Legacy',
    'https://example.invalid',
    '["a"]',
    'synthetic-ref',
    1,
    0.5,
    new Date().toISOString(),
  )
  db.close()
  const store = new Store(dir)
  assert.equal(store.providers.get('legacy').temperature, 0.5)
  assert.equal(store.providers.get('legacy').reasoningEffort, null)
  assert.deepEqual(store.providerModels.list('legacy'), [])
  store.providerModels.upsert({
    providerId: 'legacy',
    model: 'a',
    reasoningEffortSupported: true,
  })
  store.close()
})

test('message commands strip per-message sampling and model contract validates reasoning', () => {
  const input = {
    requestId: 'x',
    sessionId: 's',
    content: 'hello',
    temperature: 2,
    maxTokens: 999,
  }
  const parsed = CommandSchemaRegistry['message.send'].params.parse(input)
  assert.equal(Object.hasOwn(parsed, 'temperature'), false)
  assert.equal(Object.hasOwn(parsed, 'maxTokens'), false)
  assert.equal(
    CommandSchemaRegistry['provider.model.configure'].params.safeParse({
      requestId: 'x',
      providerId: 'p',
      model: 'a',
      reasoningEffort: 'invalid',
    }).success,
    false,
  )
})

for (const apiFormat of ['openai-chat', 'openai-responses']) {
  test(`${apiFormat} projects reasoning effort only when configured`, async (t) => {
    const bodies = []
    const server = await startServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        bodies.push(JSON.parse(raw))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          apiFormat === 'openai-chat'
            ? 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            : 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        )
      })
    })
    t.after(() => server.close())
    const options = {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'synthetic',
      model: 'a',
      messages: [{ role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
      maxRetries: 0,
    }
    await streamChat(
      { ...options, reasoningEffort: 'high' },
      apiFormat,
      () => {},
    )
    await streamChat(options, apiFormat, () => {})
    if (apiFormat === 'openai-chat') {
      assert.equal(bodies[0].reasoning_effort, 'high')
      assert.equal(Object.hasOwn(bodies[1], 'reasoning_effort'), false)
    } else {
      assert.deepEqual(bodies[0].reasoning, { effort: 'high' })
      assert.equal(Object.hasOwn(bodies[1], 'reasoning'), false)
    }
  })
}

for (const action of ['send', 'retry', 'edit']) {
  test(`${action} launches with the selected model overrides`, (t) => {
    const { store, profile } = fixture(t)
    store.providerModels.upsert({
      providerId: profile.id,
      model: 'b',
      temperature: 0.1,
      maxTokens: 8192,
      contextWindow: 256000,
      reasoningEffortSupported: true,
      reasoningEffort: 'high',
    })
    const agent = new ChatAgent(store, () => {}, null)
    t.after(() => agent.dispose())
    const launches = []
    agent.launch = (input) => launches.push(input)
    const session = store.sessions.create(null)
    const initial = agent.send({
      requestId: 'first',
      sessionId: session.id,
      content: 'first question',
      providerId: profile.id,
      model: 'a',
    })
    if (action === 'send') {
      const queued = agent.send({
        requestId: 'second',
        sessionId: session.id,
        content: 'queued question',
        providerId: profile.id,
        model: 'b',
      })
      assert.equal(queued.queued, true)
      store.runs.finalize(initial.runId, 'completed')
      agent.sendNow(session.id, queued.queueId)
    } else {
      store.runs.finalize(initial.runId, 'failed')
      if (action === 'retry')
        agent.startRetry({
          requestId: 'retry',
          runId: initial.runId,
          providerId: profile.id,
          model: 'b',
          reasoningEffort: 'low',
        })
      else
        agent.startEditResend({
          requestId: 'edit',
          sessionId: session.id,
          messageId: store.messages
            .listBySession(session.id)
            .find((m) => m.role === 'user').id,
          content: 'edited question',
          providerId: profile.id,
          model: 'b',
          reasoningEffort: 'low',
        })
    }
    assert.equal(launches.length, 2)
    const launched = launches[1]
    assert.equal(launched.model, 'b')
    assert.deepEqual(launched.sampling, { temperature: 0.1, maxTokens: 8192 })
    assert.equal(launched.profile.contextWindow, 256000)
    assert.equal(
      launched.profile.reasoningEffort,
      action === 'send' ? 'high' : 'low',
    )
  })
}

test('UI effort applies only in memory and auto clears the default without persisting a run field', (t) => {
  const { store, profile } = fixture(t)
  store.providerModels.upsert({
    providerId: profile.id,
    model: 'a',
    reasoningEffortSupported: true,
    reasoningEffort: 'high',
  })
  assert.equal(
    resolveProvider(store, profile.id, 'a', 'low').profile.reasoningEffort,
    'low',
  )
  assert.equal(
    resolveProvider(store, profile.id, 'a', null).profile.reasoningEffort,
    null,
  )
  assert.equal(
    resolveProvider(store, profile.id, 'b', 'high').profile.reasoningEffort,
    null,
  )
  assert.equal(
    store.providerModels.get(profile.id, 'a').reasoningEffort,
    'high',
  )
  const agent = new ChatAgent(store, () => {}, null)
  t.after(() => agent.dispose())
  let launch
  agent.launch = (input) => {
    launch = input
  }
  const session = store.sessions.create(null)
  const result = agent.send({
    requestId: 'ui-effort',
    sessionId: session.id,
    content: 'hello',
    providerId: profile.id,
    model: 'a',
    reasoningEffort: 'low',
  })
  assert.equal(launch.profile.reasoningEffort, 'low')
  assert.equal(
    Object.hasOwn(store.runs.get(result.runId), 'reasoningEffort'),
    false,
  )
  assert.ok(
    store.messages
      .listBySession(session.id)
      .every((message) => !Object.hasOwn(message, 'reasoningEffort')),
  )
})

test('invalid stored model values fall back safely at the read boundary', (t) => {
  const { store, profile } = fixture(t)
  store.providerModels.upsert({ providerId: profile.id, model: 'a' })
  const db = new DatabaseSync(join(store.dataDir, 'reflexion.db'))
  db.prepare(
    "UPDATE provider_models SET temperature = 3, max_tokens = -1, context_window = 0, context_budget = 'broken', reasoning_effort = 'invalid' WHERE provider_id = ?",
  ).run(profile.id)
  db.close()
  const config = store.providerModels.get(profile.id, 'a')
  for (const key of [
    'temperature',
    'maxTokens',
    'contextWindow',
    'contextBudget',
    'reasoningEffort',
  ])
    assert.equal(config[key], null)
  assert.equal(resolveProvider(store, profile.id, 'a').profile.temperature, 0.7)
})
