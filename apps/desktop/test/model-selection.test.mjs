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

test('custom options reject stale selection and incompatible inherited defaults', () => {
  const options = modelOptionsFor(
    [provider],
    [
      {
        ...configs[0],
        reasoningEffort: null,
        reasoningOptions: [{ label: '极高', value: 'xhigh' }],
      },
    ],
  )
  assert.equal(selectedEffort(options[0], null), null)
  const option = { ...options[0], defaultReasoningEffort: 'xhigh' }
  assert.equal(
    selectedEffort(option, {
      key: option.key,
      defaultValue: 'xhigh',
      value: 'high',
    }),
    'xhigh',
  )
  assert.equal(
    selectedEffort(option, {
      key: option.key,
      defaultValue: 'xhigh',
      value: 'xhigh',
    }),
    'xhigh',
  )
})

test('choice remains usable when inherited default is outside supported values', () => {
  const [option] = modelOptionsFor(
    [provider],
    [
      {
        ...configs[0],
        reasoningEffort: null,
        reasoningOptions: [{ label: '极高', value: 'xhigh' }],
      },
    ],
  )
  const defaultValue = selectedEffort(option, null)
  assert.equal(defaultValue, null)
  assert.equal(
    selectedEffort(option, { key: option.key, defaultValue, value: 'xhigh' }),
    'xhigh',
  )
})

test('unknown capabilities and unknown levels remain distinct from unsupported models', () => {
  const unknown = modelOptionsFor([provider], [])[0]
  assert.equal(unknown.reasoningUnavailableReason, '能力未知')
  const levels = modelOptionsFor(
    [provider],
    [
      {
        ...configs[0],
        reasoningEffortSupported: false,
        reasoningCapabilities: {
          thinking: true,
          effort: true,
          options: null,
          source: 'provider',
          checkedAt: null,
        },
      },
    ],
  )[0]
  assert.equal(levels.reasoningUnavailableReason, '等级未知')
  assert.equal(levels.defaultReasoningEffort, null)
  const unsupported = modelOptionsFor(
    [provider],
    [
      {
        ...configs[0],
        reasoningEffortSupported: false,
        reasoningCapabilities: {
          thinking: false,
          effort: false,
          options: null,
          source: 'provider',
          checkedAt: null,
        },
      },
    ],
  )[0]
  assert.equal(unsupported.reasoningUnavailableReason, '不支持调整')
})
