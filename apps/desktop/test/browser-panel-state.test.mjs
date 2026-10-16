import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [
    fileURLToPath(
      new URL('../frontend/features/browser/panel-state.ts', import.meta.url),
    ),
  ],
  bundle: true,
  format: 'esm',
  write: false,
})
const panel = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

test('stable snapshots and no-op visibility updates do not notify', () => {
  let updates = 0
  const unsubscribe = panel.subscribeBrowserPanel(() => updates++)
  const initial = panel.getBrowserPanelState()
  panel.setBrowserPanelOpen(false)
  assert.equal(panel.getBrowserPanelState(), initial)
  assert.equal(updates, 0)
  panel.setBrowserPanelOpen(true)
  assert.equal(updates, 1)
  assert.deepEqual(initial, { open: false })
  const opened = panel.getBrowserPanelState()
  panel.setBrowserPanelOpen(true)
  assert.equal(panel.getBrowserPanelState(), opened)
  assert.equal(updates, 1)
  panel.setBrowserPanelOpen(false)
  assert.equal(updates, 2)
  assert.deepEqual(panel.getBrowserPanelState(), { open: false })
  unsubscribe()
  panel.setBrowserPanelOpen(true)
  assert.equal(updates, 2)
  panel.setBrowserPanelOpen(false)
})
