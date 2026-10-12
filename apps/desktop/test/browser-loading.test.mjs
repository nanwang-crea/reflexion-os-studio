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
const { notice, tabs } = (await import(pathToFileURL(outfile).href)).default
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
