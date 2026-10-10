import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { acquireDataDirectoryLock } from '../dist/lifecycle/data-directory-lock.js'
import { Store } from '../dist/store/index.js'

const lockUrl = new URL(
  '../dist/lifecycle/data-directory-lock.js',
  import.meta.url,
)
const runtimePath = fileURLToPath(new URL('../dist/index.js', import.meta.url))

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('same directory is exclusive and release is idempotent', (t) => {
  const dir = directory(t)
  const release = acquireDataDirectoryLock(dir)
  t.after(release)
  assert.throws(() => acquireDataDirectoryLock(dir), /already in use/)
  release()
  release()
  acquireDataDirectoryLock(dir)()
})

test('different directories can run together', (t) => {
  const release = acquireDataDirectoryLock(directory(t))
  const otherRelease = acquireDataDirectoryLock(directory(t))
  t.after(release)
  t.after(otherRelease)
})

test('duplicate Runtime exits before recovery modifies an active turn', (t) => {
  const dir = directory(t)
  const release = acquireDataDirectoryLock(dir)
  t.after(release)
  const store = new Store(dir)
  t.after(() => store.close())
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const turn = store.turnExecutions.create({ runId: run.id, attempt: 1 })
  const child = spawnSync(process.execPath, [runtimePath], {
    env: { ...process.env, REFLEXION_DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  assert.match(child.stderr, /already in use/)
  assert.equal(child.stdout, '')
  assert.equal(store.turnExecutions.get(turn.id).phase, 'processing_input')
  assert.equal(
    store.turnExecutions.transition(turn.id, 'completed').phase,
    'completed',
  )
})

test('crashed owner releases its OS lock for restart', async (t) => {
  const dir = directory(t)
  const code = `import { acquireDataDirectoryLock } from ${JSON.stringify(lockUrl.href)};
    acquireDataDirectoryLock(process.argv[1]);
    process.stdout.write('locked');
    setInterval(() => {}, 1000);`
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', code, dir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  t.after(() => child.kill('SIGKILL'))
  await once(child.stdout, 'data')
  assert.throws(() => acquireDataDirectoryLock(dir), /already in use/)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  acquireDataDirectoryLock(dir)()
})
