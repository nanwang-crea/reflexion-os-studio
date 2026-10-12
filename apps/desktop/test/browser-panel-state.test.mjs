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

test('closing or switching away resets expansion and reopening starts in split mode', () => {
  panel.setBrowserPanelExpanded(true)
  assert.deepEqual(panel.getBrowserPanelState(), {
    open: false,
    expanded: false,
  })
  panel.setBrowserPanelOpen(true)
  panel.setBrowserPanelExpanded(true)
  assert.deepEqual(panel.getBrowserPanelState(), { open: true, expanded: true })
  panel.setBrowserPanelOpen(false)
  panel.setBrowserPanelOpen(true)
  assert.deepEqual(panel.getBrowserPanelState(), {
    open: true,
    expanded: false,
  })
  panel.setBrowserPanelOpen(false)
})

test('stable snapshots and no-op updates do not notify; subscriptions are removable', () => {
  let updates = 0
  const unsubscribe = panel.subscribeBrowserPanel(() => updates++)
  const initial = panel.getBrowserPanelState()
  panel.setBrowserPanelOpen(false)
  assert.equal(panel.getBrowserPanelState(), initial)
  assert.equal(updates, 0)
  panel.setBrowserPanelOpen(true)
  assert.equal(updates, 1)
  assert.deepEqual(initial, { open: false, expanded: false })
  panel.setBrowserPanelExpanded(true)
  assert.equal(updates, 2)
  const expanded = panel.getBrowserPanelState()
  panel.setBrowserPanelExpanded(true)
  panel.setBrowserPanelOpen(true)
  assert.equal(panel.getBrowserPanelState(), expanded)
  assert.equal(updates, 2)
  panel.setBrowserPanelExpanded(false)
  assert.equal(updates, 3)
  unsubscribe()
  panel.setBrowserPanelOpen(false)
  assert.equal(updates, 3)
})
