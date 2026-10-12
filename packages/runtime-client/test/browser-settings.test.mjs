import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserSettingsClient } from '../dist/index.js'
import {
  CommandSchemaRegistry,
  DEFAULT_BROWSER_SETTINGS,
} from '@reflexion-os-studio/contracts'

test('settings client submits valid request IDs and rejects invalid settings before transport', async () => {
  const calls = []
  const client = createBrowserSettingsClient({
    request: async (method, params) => {
      CommandSchemaRegistry[method].params.parse(params)
      calls.push(params)
      return { settings: DEFAULT_BROWSER_SETTINGS }
    },
  })
  await client.get()
  await client.update(DEFAULT_BROWSER_SETTINGS)
  assert.notEqual(calls[0].requestId, calls[1].requestId)
  await assert.rejects(
    client.update({ ...DEFAULT_BROWSER_SETTINGS, mode: 'invalid' }),
  )
  assert.equal(calls.length, 2)
})
