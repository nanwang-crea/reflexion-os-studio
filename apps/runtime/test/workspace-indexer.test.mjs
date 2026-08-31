import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { scanWorkspace } from '../dist/workspace/walker.js'
import { WorkspaceIndexer } from '../dist/workspace/indexer.js'

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# readme\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'core', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'docs', 'notes.md'), 'note\n')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
  writeFileSync(join(root, '.git', 'config'), 'ignored\n')
  try {
    symlinkSync(join(root, '..'), join(root, 'escape-link'))
  } catch {
    // Windows 无权限创建符号链接：跳过该子项。
  }
  return root
}

const fixtures = []

test('scanWorkspace counts stats, respects ignored dirs and skips symlinks', async () => {
  const root = makeWorkspace()
  fixtures.push(root)
  const stats = await scanWorkspace(root, new AbortController().signal)
  assert.equal(stats.files, 4) // README.md / index.ts / b.ts / notes.md
  assert.equal(stats.dirs, 3) // src / src/core / docs
  assert.equal(stats.totalBytes > 0, true)
  const ts = stats.extStats.find((entry) => entry.ext === '.ts')
  assert.ok(ts !== undefined && ts.files === 2)
  const md = stats.extStats.find((entry) => entry.ext === '.md')
  assert.ok(md !== undefined && md.files === 2)
  assert.equal(
    stats.extStats.some((entry) => entry.ext.includes('js')),
    false,
  )
  assert.equal(stats.truncated, false)
})

test('scanWorkspace aborts promptly on AbortSignal', async () => {
  const root = makeWorkspace()
  fixtures.push(root)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    scanWorkspace(root, controller.signal),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
})

test('indexer persists completed snapshot and emits events', async () => {
  const root = makeWorkspace()
  fixtures.push(root)
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-idx-')))
  const project = store.projects.create({ name: 'P', folderPath: root })
  const events = []
  const indexer = new WorkspaceIndexer(store, (event) => events.push(event))

  await indexer.start(project.id, root)
  const snapshot = store.workspaceIndex.get(project.id)
  assert.equal(snapshot?.status, 'completed')
  assert.equal(snapshot?.version, 1)
  assert.equal(snapshot?.fileCount, 4)
  assert.equal(
    events.some((event) => event.type === 'workspace.index.completed'),
    true,
  )
})

test('indexer marks stale when workspace root mtime moves past completedAt', async () => {
  const root = makeWorkspace()
  fixtures.push(root)
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-idx-')))
  const project = store.projects.create({ name: 'P', folderPath: root })
  const indexer = new WorkspaceIndexer(store, () => {})

  await indexer.start(project.id, root)
  // 200ms later: root dir mtime definitely newer than completedAt.
  await new Promise((resolve) => setTimeout(resolve, 200))
  utimesSync(root, new Date(), new Date())
  const snapshot = await indexer.snapshotFor(project.id)
  assert.equal(snapshot?.status, 'stale')
  assert.ok(snapshot?.staleAt !== null)
})

test('cancel during scan restores previous snapshot', async () => {
  const root = makeWorkspace()
  fixtures.push(root)
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-idx-')))
  const project = store.projects.create({ name: 'P', folderPath: root })
  const indexer = new WorkspaceIndexer(store, () => {})

  await indexer.start(project.id, root)
  assert.equal(store.workspaceIndex.get(project.id)?.status, 'completed')

  // 第二次扫描立即取消：状态应回退到上一份 completed 快照。
  const started = indexer.start(project.id, root)
  assert.equal(indexer.cancel(project.id), true)
  await started
  await new Promise((resolve) => setTimeout(resolve, 50))
  const snapshot = store.workspaceIndex.get(project.id)
  assert.equal(snapshot?.status, 'completed')
  assert.equal(snapshot?.version, 1)
})

test('recoverInterrupted marks leftover scanning rows as failed', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-idx-')))
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  store.workspaceIndex.upsert({
    projectId: project.id,
    status: 'scanning',
    version: 3,
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: null,
    staleAt: null,
    fileCount: 0,
    dirCount: 0,
    totalBytes: 0,
    extStats: [],
    truncated: false,
    error: null,
  })
  store.workspaceIndex.recoverInterrupted()
  const snapshot = store.workspaceIndex.get(project.id)
  assert.equal(snapshot?.status, 'failed')
  assert.ok(snapshot?.error !== null)
})

test.after(() => {
  for (const path of fixtures) rmSync(path, { recursive: true, force: true })
})
