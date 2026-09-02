import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-handlers-')))
}

test('agent_settings.update passes nested settings to agent', async () => {
  const received = []
  const result = await dispatchCommand(
    'agent_settings.update',
    { settings: { requestTimeoutSec: 30, requestRetries: 2 } },
    {
      store: freshStore(),
      agent: {
        updateSettings: (settings) => {
          received.push(settings)
          return { settings }
        },
      },
    },
  )
  assert.deepEqual(received, [{ requestTimeoutSec: 30, requestRetries: 2 }])
  assert.deepEqual(result, {
    settings: { requestTimeoutSec: 30, requestRetries: 2 },
  })
})

test('provider.configure forwards tuning fields with omitted, null, and value semantics', async () => {
  const store = freshStore()
  const base = {
    name: 'Test',
    baseUrl: 'https://example.test',
    models: ['model'],
    secret: 'secret',
  }
  const first = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      temperature: 0.4,
      maxTokens: 100,
      contextWindow: 1000,
      contextBudget: 700,
    },
    { store },
  )
  assert.equal(first.profile.temperature, 0.4)
  const kept = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      id: first.profile.id,
    },
    { store },
  )
  assert.equal(kept.profile.temperature, 0.4)
  assert.equal(kept.profile.maxTokens, 100)
  const cleared = await dispatchCommand(
    'provider.configure',
    {
      ...base,
      id: first.profile.id,
      temperature: null,
      maxTokens: null,
      contextWindow: null,
      contextBudget: null,
    },
    { store },
  )
  assert.equal(cleared.profile.temperature, null)
  assert.equal(cleared.profile.maxTokens, null)
  assert.equal(cleared.profile.contextWindow, null)
  assert.equal(cleared.profile.contextBudget, null)
})
