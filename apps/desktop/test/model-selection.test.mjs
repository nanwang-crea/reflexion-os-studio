import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const directory = mkdtempSync(join(tmpdir(), 'reflexion-model-selection-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const outfile = join(directory, 'model-selection.mjs')
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['frontend/hooks/session/model-selection.ts'],
  bundle: true,
  format: 'esm',
  outfile,
})
const { modelOptionsFor, selectedEffort } = await import(
  pathToFileURL(outfile).href
)

const provider = {
  id: 'p',
  name: 'Provider',
  models: ['a', 'b', 'c'],
  enabled: true,
  apiFormat: 'openai-responses',
  reasoningEffort: 'medium',
}
const configs = [
  {
    providerId: 'p',
    model: 'a',
    reasoningEffortSupported: true,
    reasoningEffort: 'high',
  },
  {
    providerId: 'p',
    model: 'b',
    reasoningEffortSupported: true,
    reasoningEffort: null,
  },
]

test('model options resolve defaults, inherited settings and unsupported capabilities', () => {
  const options = modelOptionsFor(
    [provider, { ...provider, id: 'disabled', enabled: false }],
    configs,
  )
  assert.equal(options.length, 3)
  assert.equal(options[0].defaultReasoningEffort, 'high')
  assert.equal(options[1].defaultReasoningEffort, 'medium')
  assert.equal(options[2].defaultReasoningEffort, null)
  assert.equal(options[2].reasoningEffortSupported, false)
  assert.equal(
    modelOptionsFor([{ ...provider, apiFormat: 'anthropic' }], configs)[0]
      .reasoningEffortSupported,
    false,
  )
})

test('UI effort is scoped to the selected model and resets when its default changes', () => {
  const options = modelOptionsFor([provider], configs)
  const choice = { key: 'p::a', defaultValue: 'high', value: 'low' }
  assert.equal(selectedEffort(options[0], choice), 'low')
  assert.equal(selectedEffort(options[1], choice), 'medium')
  assert.equal(selectedEffort(options[2], choice), null)
  assert.equal(
    selectedEffort({ ...options[0], defaultReasoningEffort: 'medium' }, choice),
    'medium',
  )
  assert.equal(selectedEffort(options[0], { ...choice, value: null }), null)
  assert.equal(selectedEffort(options[0], null), 'high')
})
