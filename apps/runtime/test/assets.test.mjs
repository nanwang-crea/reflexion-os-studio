import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../dist/store/index.js'
import { AssetService } from '../dist/assets/service.js'

test('AssetService imports, lists, reads and deletes workspace files', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  writeFileSync(join(workspace, 'note.md'), '# hello\nworld\n')

  const asset = await service.importWorkspace(project.id, 'note.md')
  assert.equal(asset.kind, 'text')
  assert.equal(asset.mimeType, 'text/markdown')
  assert.equal(asset.fileName, 'note.md')
  assert.equal(asset.hash.length, 64)
  assert.equal(asset.uri, `asset://${asset.assetId}`)
  assert.equal(asset.runId, null)
  assert.deepEqual(asset.metadata, { sourcePath: 'note.md' })

  const listed = service.list(project.id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].assetId, asset.assetId)

  const read = await service.read(asset.assetId)
  assert.equal(read.text, '# hello\nworld\n')
  assert.equal(read.base64, null)

  assert.equal(await service.delete(asset.assetId), true)
  await assert.rejects(service.read(asset.assetId), /not_found|asset not found/)
  assert.equal(service.list(project.id).length, 0)
  store.close()
})

test('AssetService rejects missing files and path escapes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })

  await assert.rejects(
    service.importWorkspace(project.id, 'missing.md'),
    /不存在/,
  )
  await assert.rejects(
    service.importWorkspace(project.id, '../outside.md'),
    /不允许/,
  )
  store.close()
})

test('AssetService rejects symlink escapes pointing outside workspace', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'reflexion-out-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'leak.md'))

  await assert.rejects(
    service.importWorkspace(project.id, 'leak.md'),
    /符号链接越界/,
  )
  store.close()
})

test('AssetService allows symlinks that resolve within the workspace', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  mkdirSync(join(workspace, 'nested'))
  writeFileSync(join(workspace, 'nested', 'real.txt'), 'hello from real')
  symlinkSync(
    join(workspace, 'nested', 'real.txt'),
    join(workspace, 'alias.md'),
  )

  const asset = await service.importWorkspace(project.id, 'alias.md')
  // 内容名取自 realpath 后的真实文件。
  assert.equal(asset.fileName, 'real.txt')
  assert.equal(asset.metadata.sourcePath, 'alias.md')
  const read = await service.read(asset.assetId)
  assert.equal(read.text, 'hello from real')
  store.close()
})

test('AssetService rejects symlink target sharing root prefix (component containment)', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'reflexion-prefix-'))
  const workspace = join(tmpRoot, 'ws')
  // 兄弟目录名以根目录名作前缀：字符串前缀判断会误判为“在根内”。
  const colliding = join(tmpRoot, 'ws-rooted')
  mkdirSync(workspace)
  mkdirSync(colliding)
  const store = new Store(join(tmpRoot, 'data', 'db'))
  const service = new AssetService(store, join(tmpRoot, 'data'))
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  writeFileSync(join(colliding, 'secret.txt'), 'collision file')
  symlinkSync(join(colliding, 'secret.txt'), join(workspace, 'leak.txt'))

  await assert.rejects(
    service.importWorkspace(project.id, 'leak.txt'),
    /符号链接越界/,
  )
  store.close()
})

test('AssetService removes copied file when metadata persistence fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  writeFileSync(join(workspace, 'x.txt'), 'content')

  // 故障注入：落库环节必然失败。
  store.assetStore.create = () => {
    throw new Error('db write failed')
  }

  await assert.rejects(
    service.importWorkspace(project.id, 'x.txt'),
    /db write failed/,
  )

  const destDir = join(dataDir, 'assets', project.id)
  const files = existsSync(destDir) ? readdirSync(destDir) : []
  assert.deepEqual(files, [], 'copied content must be compensated (removed)')
  store.close()
})

test('AssetService recover cleans orphans and marks missing content failed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'reflexion-assets-'))
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-ws-'))
  const store = new Store(join(dataDir, 'db'))
  const service = new AssetService(store, dataDir)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  writeFileSync(join(workspace, 'a.md'), 'aaa')
  writeFileSync(join(workspace, 'b.md'), 'bbb')

  const good = await service.importWorkspace(project.id, 'a.md')
  const ok = await service.importWorkspace(project.id, 'b.md')
  assert.equal(good.preview, 'ready')

  // 制造孤儿内容文件：有内容、无 DB 行。
  const orphanId = 'orphan-content-only'
  mkdirSync(join(dataDir, 'assets', project.id), { recursive: true })
  writeFileSync(join(dataDir, 'assets', project.id, orphanId), 'orphan')
  // 制造缺内容：删掉 good 的内容文件（DB 行仍在）。
  rmSync(join(dataDir, 'assets', project.id, good.assetId))

  await service.recover()

  assert.equal(
    existsSync(join(dataDir, 'assets', project.id, orphanId)),
    false,
    'orphan content file should be removed',
  )
  const goodAfter = service
    .list(project.id)
    .find((a) => a.assetId === good.assetId)
  assert.equal(goodAfter.preview, 'failed')
  const okAfter = service.list(project.id).find((a) => a.assetId === ok.assetId)
  assert.equal(okAfter.preview, 'ready')
  store.close()
})
