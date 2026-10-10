import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Keep this connection open until exit, including while agents shut down. */
export function acquireDataDirectoryLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'runtime-lock.db'))
  try {
    // A separate rollback-journal database avoids blocking normal WAL writes.
    // SQLite's OS locks are atomic and released even after a process crash.
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if (
      error instanceof Error &&
      'errcode' in error &&
      (error.errcode === 5 || error.errcode === 6)
    ) {
      throw new Error(
        'Runtime data directory is already in use. Close the other instance before restarting.',
        { cause: error },
      )
    }
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    db.close()
  }
}
