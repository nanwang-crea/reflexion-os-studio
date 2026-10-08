import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [
    new URL('../frontend/lib/theme/index.ts', import.meta.url).pathname,
  ],
  bundle: true,
  format: 'esm',
  write: false,
})
const source = result.outputFiles[0].text

function environment(value) {
  const values = new Map(value ? [['appearance.theme', value]] : [])
  const media = new EventTarget()
  media.matches = false
  const window = new EventTarget()
  window.matchMedia = () => media
  globalThis.window = window
  globalThis.document = { documentElement: { dataset: {} } }
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  return { media, window, values }
}
async function load(id) {
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${id}`
  )
}

test('theme persists, restores, follows system only when selected, and unsubscribes', async () => {
  const { media, values } = environment('light')
  const theme = await load('main')
  theme.initializeTheme()
  theme.initializeTheme()
  assert.equal(theme.getResolvedTheme(), 'light')
  assert.equal(document.documentElement.dataset.theme, 'light')
  let updates = 0
  const unsubscribe = theme.subscribeTheme(() => updates++)
  theme.setThemePreference('dark')
  assert.equal(values.get('appearance.theme'), 'dark')
  media.dispatchEvent(new Event('change'))
  assert.equal(updates, 1)
  theme.setThemePreference('system')
  assert.equal(theme.getResolvedTheme(), 'light')
  media.matches = true
  media.dispatchEvent(new Event('change'))
  assert.equal(theme.getResolvedTheme(), 'dark')
  unsubscribe()
  theme.setThemePreference('light')
  assert.equal(updates, 3)
  const restored = await load('restored')
  restored.initializeTheme()
  assert.equal(restored.getThemePreference(), 'light')
})

test('invalid or unavailable storage does not block theme switching', async () => {
  environment('unknown')
  const theme = await load('fallback')
  theme.initializeTheme()
  assert.equal(theme.getThemePreference(), 'dark')
  localStorage.setItem = () => {
    throw new Error('storage unavailable')
  }
  theme.setThemePreference('light')
  assert.equal(theme.getResolvedTheme(), 'light')
})
