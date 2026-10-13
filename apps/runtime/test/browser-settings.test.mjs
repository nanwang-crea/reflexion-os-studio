import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_BROWSER_SETTINGS } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'

test('browser settings survive reopening and migrate draft preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-browser-settings-'))
  const store = new Store(dir)
  const defaults = store.browserSettings.get()
  assert.equal(defaults.defaultRoute, 'system')
  const settings = {
    ...defaults,
    defaultRoute: 'embedded',
    localRoute: 'system',
    showFullUrl: false,
  }
  store.browserSettings.upsert(settings)
  store.close()
  const reopened = new Store(dir)
  assert.deepEqual(reopened.browserSettings.get(), settings)
  reopened.close()
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.prepare('UPDATE browser_settings SET settings_json = ? WHERE id = 1').run(
    JSON.stringify({
      mode: 'embedded',
      defaultRoute: 'embedded',
      allowLocalhost: false,
      homepageUrl: 'https://example.com',
    }),
  )
  db.close()
  const migrated = new Store(dir)
  assert.deepEqual(migrated.browserSettings.get(), {
    ...DEFAULT_BROWSER_SETTINGS,
    mode: 'embedded',
    defaultRoute: 'embedded',
    localRoute: 'system',
    showFullUrl: true,
  })
  migrated.close()
})

test('v40 database upgrades to browser settings while retaining project data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-browser-v40-'))
  const original = new Store(dir)
  const project = original.projects.create({
    name: 'Migration fixture',
    folderPath: dir,
  })
  original.close()
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.exec('DROP TABLE browser_settings; PRAGMA user_version = 40')
  db.close()
  const upgraded = new Store(dir)
  assert.equal(upgraded.projects.get(project.id).name, 'Migration fixture')
  assert.equal(upgraded.browserSettings.get().defaultRoute, 'system')
  upgraded.close()
  const inspect = new DatabaseSync(join(dir, 'reflexion.db'))
  assert.ok(inspect.prepare('PRAGMA user_version').get().user_version >= 42)
  inspect.close()
})

test('history is opt-in, searchable literally, paginated and cleared per exact origin', async () => {
  const { browserDataCommandHandlers: handlers } =
    await import('../dist/browser/data/handlers.js')
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-browser-data-')),
  )
  try {
    const record = (url, title) =>
      handlers['browser_history.record']({ url, title }, { store })
    assert.equal(record('https://one.test/', 'private').recorded, false)
    store.browserSettings.upsert({
      ...store.browserSettings.get(),
      saveHistory: true,
    })
    assert.equal(record('https://one.test/', 'still temporary').recorded, false)
    store.browserSettings.upsert({
      ...store.browserSettings.get(),
      storageMode: 'persistent',
    })
    assert.equal(record('https://one.test/', 'literal % query').recorded, true)
    record('https://two.test/', 'second')
    assert.equal(store.browserHistory.list('%', 100).length, 1)
    const page = store.browserHistory.list('', 1)
    assert.equal(page[0].origin, 'https://two.test')
    assert.equal(
      store.browserHistory.list('', 1, Number(page[0].id))[0].origin,
      'https://one.test',
    )
    assert.equal(store.browserHistory.clear('https://one.test'), 1)
    assert.equal(store.browserHistory.list('', 100).length, 1)
    store.browserSettings.upsert({
      ...store.browserSettings.get(),
      mode: 'system',
    })
    assert.equal(record('https://one.test/', 'system').recorded, false)
    const contact = {
      id: 'fixture',
      label: 'Example',
      name: 'Tester',
      email: 'test@example.test',
      phone: '',
      address: '',
    }
    store.browserContacts.save(contact)
    assert.deepEqual(store.browserContacts.list(), [contact])
    assert.equal(store.browserContacts.delete(contact.id), true)
    assert.equal(store.browserContacts.list().length, 0)
  } finally {
    store.close()
  }
})

test('removing the static Agent toggle preserves saved user browser preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-browser-retired-agent-'))
  const store = new Store(dir)
  const settings = {
    ...DEFAULT_BROWSER_SETTINGS,
    defaultRoute: 'embedded',
    showFullUrl: false,
    storageMode: 'persistent',
    saveHistory: true,
  }
  store.browserSettings.upsert(settings)
  store.close()
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.prepare('UPDATE browser_settings SET settings_json = ? WHERE id = 1').run(
    JSON.stringify({ ...settings, agentEnabled: true }),
  )
  db.close()
  const reopened = new Store(dir)
  try {
    assert.deepEqual(reopened.browserSettings.get(), settings)
  } finally {
    reopened.close()
  }
})

test('independent Agent settings preserve user browser preferences, persist display and revoke on change', async () => {
  const { agentBrowserSettingsCommandHandlers: agentHandlers } =
    await import('../dist/browser/agent/handlers.js')
  const { browserSettingsCommandHandlers: userHandlers } =
    await import('../dist/browser-settings/handlers.js')
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-agent-display-'))
  const store = new Store(dir)
  const user = {
    ...store.browserSettings.get(),
    defaultRoute: 'embedded',
    saveHistory: true,
  }
  store.browserSettings.upsert(user)
  let revoked = 0
  const context = { store, browser: { revoke: () => ++revoked } }
  try {
    agentHandlers['agent_browser_settings.update'](
      { settings: { enabled: true, display: 'headed' } },
      context,
    )
    assert.equal(revoked, 1)
    assert.equal(store.browserSettings.get().saveHistory, true)
    assert.equal(store.browserSettings.get().defaultRoute, 'embedded')
    // A stale ordinary-browser update cannot overwrite the independent Agent settings.
    userHandlers['browser_settings.update'](
      { settings: { ...user, showFullUrl: false } },
      context,
    )
    assert.deepEqual(
      agentHandlers['agent_browser_settings.get']({}, context).settings,
      { enabled: true, display: 'headed', approval: 'follow-session' },
    )
    agentHandlers['agent_browser_settings.update'](
      { settings: { enabled: true, display: 'headed' } },
      context,
    )
    assert.equal(revoked, 1)
    agentHandlers['agent_browser_settings.update'](
      { settings: { enabled: true, display: 'headed', approval: 'ask' } },
      context,
    )
    assert.equal(revoked, 2)
    assert.equal(store.browserSettings.get().agentBrowserApproval, 'ask')
    agentHandlers['agent_browser_settings.update'](
      { settings: { enabled: false, display: 'headed' } },
      context,
    )
    assert.equal(revoked, 3)
  } finally {
    store.close()
  }
  const reopened = new Store(dir)
  try {
    assert.equal(reopened.browserSettings.get().agentBrowserDisplay, 'headed')
  } finally {
    reopened.close()
  }
})
