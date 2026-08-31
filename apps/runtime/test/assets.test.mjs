import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
