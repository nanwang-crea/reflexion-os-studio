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
