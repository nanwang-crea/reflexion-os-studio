import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeBrowserUrl,
  parseResourceUri,
  BrowserActionSchema,
  lookupCommandSchema,
} from '../dist/index.js'

test('web addresses support HTTP, HTTPS, ports, IPv6 and internal hosts', () => {
  for (const [input, expected] of [
    ['example.com/path', 'https://example.com/path'],
    ['localhost:3000', 'https://localhost:3000/'],
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['http://[::1]:3000', 'http://[::1]:3000/'],
    ['http://192.168.1.2', 'http://192.168.1.2/'],
    ['http://intranet', 'http://intranet/'],
  ])
    assert.equal(normalizeBrowserUrl(input), expected)
  assert.deepEqual(parseResourceUri('http://localhost:3000/a#b'), {
    kind: 'externalUrl',
    uri: 'http://localhost:3000/a#b',
  })
})

test('rejects executable, file, internal protocols, malformed URLs and credentials', () => {
  for (const value of [
    'file:///tmp/a',
    'javascript:alert(1)',
    'data:text/html,x',
    'blob:https://example.com/x',
    'tauri://localhost',
    'asset://id',
    'ftp://example.com',
    'https://user:sample@example.com',
    'https://example.com/a b',
    'http://',
    '',
  ]) {
    assert.throws(() => normalizeBrowserUrl(value), undefined, value)
  }
  assert.throws(() => parseResourceUri('https://user:sample@example.com'))
})

test('user Surface has no script/DOM operations or Agent Runtime commands', () => {
  for (const action of [
    { kind: 'read' },
    { kind: 'click' },
    { kind: 'evaluate', script: '1+1' },
    { kind: 'reload', script: '1+1' },
  ])
    assert.equal(BrowserActionSchema.safeParse(action).success, false)
  for (const method of [
    'browser_open',
    'browser_control',
    'browser.read',
    'browser.click',
  ])
    assert.equal(lookupCommandSchema(method), undefined)
})

test('native panel layout validates finite bounded geometry and denies extra fields', () => {
  const layout = {
    kind: 'layout',
    x: 20,
    y: 120,
    width: 500,
    height: 600,
    visible: true,
  }
  assert.equal(BrowserActionSchema.safeParse(layout).success, true)
  for (const bad of [
    { ...layout, x: -1 },
    { ...layout, width: Infinity },
    { ...layout, height: NaN },
    { ...layout, y: 100001 },
    { ...layout, visible: 'true' },
    { ...layout, script: '1+1' },
  ])
    assert.equal(BrowserActionSchema.safeParse(bad).success, false)
})

test('tab operations are bounded and cannot carry script or profile paths', () => {
  for (const action of [
    { kind: 'newtab' },
    { kind: 'newtab', url: 'https://example.test' },
    { kind: 'selecttab', tabId: 1 },
    { kind: 'closetab', tabId: 2 },
  ])
    assert.equal(BrowserActionSchema.safeParse(action).success, true)
  for (const action of [
    { kind: 'selecttab', tabId: 0 },
    { kind: 'closetab', tabId: -1 },
    { kind: 'newtab', script: 'secret' },
  ])
    assert.equal(BrowserActionSchema.safeParse(action).success, false)
})

test('direct import restricts source profiles and never returns credential values', async () => {
  const {
    BrowserImportRequestSchema,
    BrowserImportResultSchema,
    BrowserCredentialsSchema,
  } = await import('../dist/index.js')
  assert.equal(
    BrowserImportRequestSchema.safeParse({
      source: 'chrome',
      profile: 'Default',
      cookies: true,
      passwords: false,
    }).success,
    true,
  )
  for (const profile of [
    '/tmp/profile',
    '../Default',
    'Profile 0',
    'Profile -1',
  ])
    assert.equal(
      BrowserImportRequestSchema.safeParse({
        source: 'edge',
        profile,
        cookies: true,
        passwords: true,
      }).success,
      false,
    )
  assert.equal(
    BrowserImportRequestSchema.safeParse({
      source: 'chrome',
      profile: 'Default',
      cookies: false,
      passwords: false,
    }).success,
    false,
  )
  assert.equal(
    BrowserImportResultSchema.safeParse({
      cookies: 1,
      passwords: 2,
      skipped: 3,
      cancelled: false,
      notice: 'complete',
      value: 'forbidden',
    }).success,
    false,
  )
  assert.equal(
    BrowserCredentialsSchema.safeParse([
      {
        id: 1,
        origin: 'https://example.test',
        label: 'account',
        password: 'forbidden',
      },
    ]).success,
    false,
  )
})
