import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(tmpdir(), 'reflexion-storage-test')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'permission-storage.mjs')
await build({
  entryPoints: [join(ROOT, 'frontend/hooks/permission-storage.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
})
const { migratePreset, loadPreset, savePreset, isPermissionPreset } =
  await import(`file://${outfile}`)

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    map,
  }
}

test('migratePreset：v2 值直通；任何 legacy 值收敛为 workspace-read', () => {
  assert.equal(migratePreset('workspace-write', null), 'workspace-write')
  assert.equal(migratePreset('workspace-full', 'workspace'), 'workspace-full')
  assert.equal(migratePreset(null, 'workspace'), 'workspace-read')
  assert.equal(migratePreset(null, 'read-only'), 'workspace-read')
  assert.equal(migratePreset(null, null), 'workspace-read')
  assert.equal(migratePreset('trusted', null), 'workspace-read')
  assert.equal(migratePreset('garbage', null), 'workspace-read')
  assert.equal(isPermissionPreset('danger'), false)
})

test('loadPreset：写入 v2、删除 legacy、异常回落最窄档', () => {
  const storage = fakeStorage({ 'reflexion.permission-mode': 'workspace' })
  assert.equal(loadPreset(storage), 'workspace-read')
  assert.equal(
    storage.map.get('reflexion.permission-preset.v2'),
    'workspace-read',
  )
  assert.equal(storage.map.has('reflexion.permission-mode'), false)

  const v2 = fakeStorage({ 'reflexion.permission-preset.v2': 'workspace-full' })
  assert.equal(loadPreset(v2), 'workspace-full')

  const broken = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {},
    removeItem() {},
  }
  assert.equal(loadPreset(broken), 'workspace-read')
  assert.equal(loadPreset(null), 'workspace-read')
})

test('savePreset 写入 v2 key；storage 缺失静默', () => {
  const storage = fakeStorage()
  savePreset(storage, 'workspace-write')
  assert.equal(
    storage.map.get('reflexion.permission-preset.v2'),
    'workspace-write',
  )
  savePreset(null, 'workspace-full')
})
