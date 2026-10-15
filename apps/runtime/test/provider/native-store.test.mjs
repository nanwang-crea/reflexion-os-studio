import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../dist/store/index.js'
import { LATEST_SCHEMA_VERSION } from '../../dist/store/schema.js'

test('v48 database upgrade adds nullable native continuation without rewriting history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-migration-'))
  let store = new Store(dir)
  try {
    const session = store.sessions.create(null)
    const message = store.messages.create({
      sessionId: session.id,
      runId: null,
      role: 'assistant',
      content: 'old',
      status: 'completed',
    })
    store.messages.finalize(message.id, 'old', 'completed', 'old thought')
    store.close()
    const db = new DatabaseSync(join(dir, 'reflexion.db'))
    db.exec('ALTER TABLE messages DROP COLUMN provider_continuation_json')
    db.exec('PRAGMA user_version = 48')
    db.close()
    store = new Store(dir)
    assert.equal(
      store.messages.listBySession(session.id)[0].reasoning,
      'old thought',
    )
    assert.equal(
      store.messages.listBySession(session.id)[0].providerContinuation,
      undefined,
    )
    const upgraded = new DatabaseSync(join(dir, 'reflexion.db'))
    assert.equal(
      upgraded.prepare('PRAGMA user_version').get().user_version,
      LATEST_SCHEMA_VERSION,
    )
    upgraded.close()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
