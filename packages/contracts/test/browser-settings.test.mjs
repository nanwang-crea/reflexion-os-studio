import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BrowserSettingsSchema,
  DEFAULT_BROWSER_SETTINGS,
  browserRoute,
  normalizeBrowserUrl,
} from '../dist/index.js'

test('ordinary and loopback routes are independent and default to system', () => {
  assert.equal(
    browserRoute(DEFAULT_BROWSER_SETTINGS, 'https://example.com'),
    'system',
  )
  const settings = { ...DEFAULT_BROWSER_SETTINGS, localRoute: 'embedded' }
  for (const url of [
    'http://localhost?x=1',
    'http://localhost.:3000',
    'http://127.2.3.4',
    'http://[::1]:3000',
    '127.1:8000',
  ]) {
    assert.equal(
      browserRoute(settings, normalizeBrowserUrl(url)),
      'embedded',
      url,
    )
  }
  for (const url of [
    'http://192.168.1.2',
    'http://localhost.example.com',
    'https://example.com/localhost',
  ]) {
    assert.equal(browserRoute(settings, url), 'system', url)
  }
  assert.equal(
    browserRoute({ ...settings, mode: 'system' }, 'http://localhost'),
    'system',
  )
})

test('settings reject unrelated URL and credential fields', () => {
  assert.equal(
    BrowserSettingsSchema.safeParse({
      ...DEFAULT_BROWSER_SETTINGS,
      homepageUrl: 'javascript:alert(1)',
    }).success,
    false,
  )
  assert.equal(
    BrowserSettingsSchema.safeParse({
      ...DEFAULT_BROWSER_SETTINGS,
      secret: 'fixture',
    }).success,
    false,
  )
})

test('address search and fixed homepages cannot smuggle executable schemes', async () => {
  const { browserAddressUrl, browserHomeUrl, BrowserSiteRuleSchema } =
    await import('../dist/index.js')
  assert.equal(
    new URL(
      browserAddressUrl('cats & dogs', DEFAULT_BROWSER_SETTINGS),
    ).searchParams.get('q'),
    'cats & dogs',
  )
  assert.equal(
    browserAddressUrl('example.com', DEFAULT_BROWSER_SETTINGS),
    'https://example.com/',
  )
  assert.throws(() =>
    browserAddressUrl('javascript:alert(1)', DEFAULT_BROWSER_SETTINGS),
  )
  assert.equal(browserHomeUrl(DEFAULT_BROWSER_SETTINGS), undefined)
  assert.equal(
    BrowserSiteRuleSchema.safeParse({
      origin: 'https://example.com/path',
      permission: 'camera',
      policy: 'ask',
    }).success,
    false,
  )
  assert.equal(
    BrowserSiteRuleSchema.safeParse({
      origin: 'https://example.com',
      permission: 'camera',
      policy: 'allow',
    }).success,
    false,
  )
})

test('Agent browser display defaults to headless and only accepts supported modes', async () => {
  const { AgentBrowserSettingsSchema } = await import('../dist/index.js')
  assert.deepEqual(AgentBrowserSettingsSchema.parse({}), {
    enabled: false,
    display: 'headless',
    approval: 'follow-session',
    source: 'auto',
    lifetime: 'session',
  })
  assert.equal(
    BrowserSettingsSchema.parse({ mode: 'embedded', defaultRoute: 'system' })
      .agentBrowserDisplay,
    'headless',
  )
  assert.equal(
    AgentBrowserSettingsSchema.parse({ enabled: true, display: 'headed' })
      .display,
    'headed',
  )
  assert.equal(
    AgentBrowserSettingsSchema.safeParse({ enabled: true, display: 'auto' })
      .success,
    false,
  )
})

test('Agent browser source rejects arbitrary executable paths and settings results match handlers', async () => {
  const { AgentBrowserSettingsSchema, CommandSchemaRegistry } =
    await import('../dist/index.js')
  assert.equal(
    AgentBrowserSettingsSchema.safeParse({ source: '/tmp/custom-browser' })
      .success,
    false,
  )
  for (const source of ['auto', 'system-chrome', 'managed'])
    assert.equal(AgentBrowserSettingsSchema.parse({ source }).source, source)
  const settings = AgentBrowserSettingsSchema.parse({})
  for (const command of [
    'agent_browser_settings.get',
    'agent_browser_settings.update',
  ]) {
    assert.equal(
      CommandSchemaRegistry[command].result.safeParse({ settings }).success,
      true,
    )
  }
})
