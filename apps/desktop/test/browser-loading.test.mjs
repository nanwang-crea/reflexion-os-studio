import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'reflexion-browser-loading-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const outfile = join(directory, 'loading.cjs')
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: {
    contents: `
      import { createElement } from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { BrowserLoadNotice } from './frontend/features/browser/BrowserLoadNotice'
      export { updateLoadingProgress } from './frontend/features/browser/useLoadingProgress'
      import { BrowserTabs } from './frontend/features/browser/BrowserTabs'
      export const notice = (state) => renderToStaticMarkup(createElement(BrowserLoadNotice, { state, error: null, navigate: async () => {}, external: async () => {} }))
      export const tabs = (state) => renderToStaticMarkup(createElement(BrowserTabs, { state, control: async () => {} }))
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  outfile,
})
const { notice, tabs, updateLoadingProgress } = (
  await import(pathToFileURL(outfile).href)
).default
const tab = {
  id: 1,
  title: 'Stable title',
  status: 'loading',
  progress: 0.5,
  url: 'https://example.com/',
  canGoBack: false,
  canGoForward: false,
  notice: null,
}
const state = {
  ...tab,
  tabs: [tab],
  activeTabId: 1,
  available: true,
  revision: 1,
}

test('loading uses progress without flashing placeholder text or replacing the page title', () => {
  assert.match(notice(state), /scaleX\(0.5\)/)
  assert.doesNotMatch(notice(state), /正在加载|正在加载网页|尝试 HTTP/)
  assert.match(tabs(state), /Stable title/)
  assert.doesNotMatch(tabs(state), /加载中/)
})

test('failed HTTPS loads offer retry without an automatic HTTP downgrade', () => {
  const failed = notice({ ...state, status: 'failed', notice: '加载失败' })
  assert.match(failed, /重试/)
  assert.match(failed, /系统浏览器打开/)
  assert.doesNotMatch(failed, /尝试 HTTP|尝试 HTTPS/)
})

test('redirect gaps preserve progress and another tab starts independently', () => {
  const idle = { tabId: 1, value: 0, visible: false, running: false }
  const loading = updateLoadingProgress(idle, 1, 'loading', 0.6)
  const gap = updateLoadingProgress(loading, 1, 'ready', 0)
  assert.equal(gap, loading)
  const redirected = updateLoadingProgress(gap, 1, 'loading', 0.1)
  assert.equal(redirected.value, 0.6)
  assert.equal(redirected.visible, true)
  const other = updateLoadingProgress(redirected, 2, 'loading', 0.1)
  assert.equal(other.value, 0.1)
  assert.equal(other.tabId, 2)
})

test('a new navigation restarts after fade; failures and stops clear the bar', () => {
  const faded = { tabId: 1, value: 1, visible: false, running: false }
  const next = updateLoadingProgress(faded, 1, 'loading', 0)
  assert.equal(next.value, 0.03)
  for (const status of ['failed', 'idle', undefined]) {
    const stopped = updateLoadingProgress(next, 1, status, 0)
    assert.equal(stopped.visible, false)
    assert.equal(stopped.running, false)
  }
  assert.equal(updateLoadingProgress(faded, 1, 'loading', 1).value, 0.95)
})
