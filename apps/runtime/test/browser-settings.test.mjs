import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 41)
  inspect.close()
})
