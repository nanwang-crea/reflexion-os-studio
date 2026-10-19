import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../dist/store/index.js'
import { saveSecret } from '../../dist/secrets.js'
import {
  effectiveProviderModel,
  knownCapabilities,
} from '../../dist/provider/models/capabilities.js'
import { parseModelMetadata } from '../../dist/provider/models/metadata.js'
import {
  listEffectiveModels,
  refreshModelCapabilities,
} from '../../dist/provider/models/discovery.js'
import { resolveProvider } from '../../dist/agent/provider-resolver.js'
import { providerCommandHandlers } from '../../dist/provider/handlers.js'

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'model-capabilities-'))
  const store = new Store(dir)
  const profile = store.providers.upsert({
    name: 'Metadata fixture',
    baseUrl: 'https://provider.invalid/v1',
    models: ['a', 'b'],
    enabled: true,
    secretRef: saveSecret('synthetic-capability-key'),
    ...extra,
  })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, profile }
}
const checkedAt = '2026-10-19T00:00:00.000Z'
const metadata = {
  id: 'a',
  capabilities: {
    thinking: { supported: true },
    effort: {
      supported: true,
      low: { supported: true },
      high: { supported: true },
    },
  },
}

test('metadata separates thinking, effort and unknown levels without guessing', () => {
  assert.equal(parseModelMetadata({ id: 'x' }, checkedAt), null)
  const thinking = parseModelMetadata(
    { id: 'x', supported_parameters: ['reasoning'] },
    checkedAt,
  ).capabilities
  assert.equal(thinking.thinking, true)
  assert.equal(thinking.effort, null)
  assert.equal(thinking.options, null)
  const effort = parseModelMetadata(
    { id: 'x', supported_parameters: ['reasoning_effort'] },
    checkedAt,
  ).capabilities
  assert.equal(effort.effort, true)
  assert.equal(effort.options, null)
  assert.deepEqual(
    parseModelMetadata(metadata, checkedAt).capabilities.options.map(
      (x) => x.value,
    ),
    ['low', 'high'],
  )
  assert.equal(
    parseModelMetadata(
      { id: 'x', capabilities: { thinking: { supported: false } } },
      checkedAt,
    ).capabilities.thinking,
    false,
  )
  assert.equal(
    parseModelMetadata(
      {
        ...metadata,
        reasoning_options: [{ label: 'bad', value: 'invalid value' }],
      },
      checkedAt,
    ),
    null,
  )
})

test('catalog is exact and origin-scoped; unknown is not unsupported', (t) => {
  const { profile } = fixture(t, { baseUrl: 'https://api.openai.com/v1' })
  assert.equal(knownCapabilities(profile, 'o3').thinking, true)
  assert.equal(knownCapabilities(profile, 'gpt-4.1').thinking, false)
  assert.deepEqual(
    knownCapabilities(profile, 'gpt-5.2').options.map((x) => x.value),
    ['none', 'low', 'medium', 'high', 'xhigh'],
  )
  assert.equal(knownCapabilities(profile, 'gpt-5.2-custom').thinking, null)
  assert.equal(
    knownCapabilities(
      { ...profile, baseUrl: 'https://gateway.invalid/v1' },
      'o3',
    ).thinking,
    null,
  )
  assert.equal(
    effectiveProviderModel(profile, 'unknown', null).reasoningCapabilities
      .effort,
    null,
  )
})

test('refresh reads metadata only, caches persist, manual overrides win and auto restores detection', async (t) => {
  const { store, profile } = fixture(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++
    assert.equal(String(url), 'https://provider.invalid/v1/models')
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, undefined)
    assert.equal(options.body, undefined)
    return Response.json({
      data: [
        metadata,
        { id: 'unconfigured', supported_parameters: ['reasoning_effort'] },
      ],
    })
  })
  assert.equal(await refreshModelCapabilities(store, profile), undefined)
  assert.equal(requests, 1)
  assert.equal(listEffectiveModels(store, profile).length, 2)
  assert.equal(store.providerModels.get(profile.id, 'unconfigured'), null)
  assert.equal(
    resolveProvider(store, profile.id, 'a', 'high').profile.reasoningEffort,
    'high',
  )
  assert.throws(
    () => resolveProvider(store, profile.id, 'a', 'medium'),
    /支持列表/,
  )
  store.providerModels.upsert({
    providerId: profile.id,
    model: 'a',
    reasoningMode: 'manual',
    reasoningEffortSupported: false,
    thinkingSupported: false,
  })
  await refreshModelCapabilities(store, profile)
  assert.equal(
    listEffectiveModels(store, profile)[0].reasoningCapabilities.source,
    'manual',
  )
  assert.equal(
    resolveProvider(store, profile.id, 'a', 'high').profile.reasoningEffort,
    null,
  )
  store.providerModels.upsert({
    providerId: profile.id,
    model: 'a',
    reasoningMode: 'auto',
  })
  assert.equal(
    resolveProvider(store, profile.id, 'a', 'high').profile.reasoningEffort,
    'high',
  )
  const reopened = new Store(store.dataDir)
  assert.equal(
    listEffectiveModels(reopened, profile)[0].reasoningCapabilities.source,
    'provider',
  )
  reopened.close()
})

test('failed refresh keeps cache and does not expose raw errors or credentials', async (t) => {
  const { store, profile } = fixture(t)
  store.providerModels.saveDetection(
    profile.id,
    'a',
    parseModelMetadata(metadata, checkedAt).capabilities,
  )
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('synthetic-private-error')
  })
  const warning = await refreshModelCapabilities(store, profile)
  assert.match(warning, /保留缓存/)
  assert.doesNotMatch(warning, /synthetic/)
  assert.equal(
    listEffectiveModels(store, profile)[0].reasoningEffortSupported,
    true,
  )
})

test('Anthropic pagination and authentication preserve model capability but gate adapter parameters', async (t) => {
  const { store, profile } = fixture(t, {
    apiFormat: 'anthropic',
    baseUrl: 'https://provider.invalid',
  })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++
    assert.equal(options.headers['anthropic-version'], '2023-06-01')
    assert.ok(options.headers['x-api-key'])
    assert.equal(options.headers.authorization, undefined)
    if (requests === 1)
      return Response.json({ data: [], has_more: true, last_id: 'cursor' })
    assert.equal(new URL(url).searchParams.get('after_id'), 'cursor')
    return Response.json({ data: [metadata], has_more: false })
  })
  assert.equal(await refreshModelCapabilities(store, profile), undefined)
  const config = listEffectiveModels(store, profile)[0]
  assert.equal(config.reasoningCapabilities.effort, true)
  assert.equal(config.reasoningEffortSupported, false)
  assert.equal(
    resolveProvider(store, profile.id, 'a', 'high').profile.reasoningEffort,
    null,
  )
})

test('provider edits invalidate cache and in-flight responses cannot overwrite new configuration', async (t) => {
  const { store, profile } = fixture(t)
  store.providerModels.saveDetection(
    profile.id,
    'a',
    parseModelMetadata(metadata, checkedAt).capabilities,
  )
  const changed = providerCommandHandlers['provider.configure'](
    { ...profile, baseUrl: 'https://new.invalid/v1' },
    { store },
  ).profile
  assert.equal(
    store.providerModels.get(profile.id, 'a').reasoningCapabilities,
    undefined,
  )
  t.mock.method(globalThis, 'fetch', async () => {
    store.providers.upsert({ ...changed, baseUrl: 'https://other.invalid/v1' })
    return Response.json({ data: [metadata] })
  })
  assert.match(await refreshModelCapabilities(store, changed), /配置已更改/)
  assert.equal(
    store.providerModels.get(profile.id, 'a').reasoningCapabilities,
    undefined,
  )
})

test('v50 migration preserves legacy manual overrides without rewriting values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'capability-migration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const before = new Store(dir)
  const profile = before.providers.upsert({
    name: 'Legacy',
    baseUrl: 'https://api.openai.com/v1',
    models: ['o3'],
    enabled: true,
    secretRef: 'synthetic-ref',
  })
  before.providerModels.upsert({
    providerId: profile.id,
    model: 'o3',
    reasoningEffortSupported: false,
  })
  before.close()
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  for (const column of [
    'reasoning_mode',
    'thinking_supported',
    'reasoning_capabilities_json',
  ])
    db.exec(`ALTER TABLE provider_models DROP COLUMN ${column}`)
  db.exec('PRAGMA user_version = 50')
  db.close()
  const after = new Store(dir)
  assert.equal(
    after.providerModels.get(profile.id, 'o3').reasoningMode,
    'manual',
  )
  assert.equal(
    listEffectiveModels(after, profile)[0].reasoningEffortSupported,
    false,
  )
  after.close()
})
