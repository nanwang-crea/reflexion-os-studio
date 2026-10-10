import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  existsSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../dist/store/index.js'
import { assetCommandHandlers } from '../dist/assets/handlers.js'
import { AssetService } from '../dist/assets/service.js'
import { userContentParts } from '../dist/agent/context/image-parts.js'
import { resolveModelImages } from '../dist/agent/context/model-images.js'
import {
  reconstructSessionFramesWithIds,
  framesToValidatedMessages,
} from '../dist/agent/context/context-frames.js'
import { QueueService } from '../dist/agent/session/queue.js'
import { streamChat } from '../dist/provider.js'
import { startServer } from './fixtures/provider-server.mjs'
import {
  framesToMessages,
  messagesToFrames,
  estimateMessageTokens,
} from '@reflexion-os-studio/agent-core'
import {
  CommandSchemaRegistry,
  MAX_IMAGE_BYTES,
} from '@reflexion-os-studio/contracts'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'multimodal-'))
  const store = new Store(dir)
  const assets = new AssetService(store, dir)
  const session = store.sessions.create(null)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store, assets, session }
}
const upload = (sessionId, overrides = {}) => ({
  sessionId,
  fileName: 'pixel.png',
  mimeType: 'image/png',
  base64: png,
  ...overrides,
})

test('standalone uploads persist references, hydrate only at model boundary, and survive restart', async (t) => {
  const f = fixture(t)
  const asset = await f.assets.uploadImage(upload(f.session.id))
  assert.equal(asset.projectId, null)
  assert.equal(asset.sessionId, f.session.id)
  const parts = userContentParts(f.store, f.session.id, 'describe', [
    asset.assetId,
  ])
  const message = f.store.messages.create({
    sessionId: f.session.id,
    runId: null,
    role: 'user',
    content: 'describe',
    status: 'completed',
    parts,
  })
  const history = framesToValidatedMessages(
    reconstructSessionFramesWithIds(f.store, f.session.id, 'system').frames,
  )
  assert.equal(history[1].images[0].assetId, asset.assetId)
  assert.equal(history[1].images[0].base64, undefined)
  assert.deepEqual(framesToMessages(messagesToFrames(history)), history)
  assert.ok(estimateMessageTokens(history) >= 4096)
  const hydrated = await resolveModelImages(
    f.store,
    f.session.id,
    history,
    new AbortController().signal,
  )
  assert.equal(hydrated[1].images[0].base64, png)
  assert.equal(history[1].images[0].base64, undefined)
  await assert.rejects(f.assets.delete(asset.assetId), /不能删除/)
  const reopened = new Store(f.dir)
  try {
    assert.deepEqual(
      reopened.messages.listBySession(f.session.id)[0].parts,
      message.parts,
    )
    assert.equal(
      (await new AssetService(reopened, f.dir).read(asset.assetId)).base64,
      png,
    )
  } finally {
    reopened.close()
  }
})

test('uploads validate encoding, bytes, formats, limits, missing and foreign sessions', async (t) => {
  const f = fixture(t)
  await assert.rejects(f.assets.uploadImage(upload('missing')), /会话不存在/)
  await assert.rejects(
    f.assets.uploadImage(upload(f.session.id, { base64: 'not base64' })),
    /无效/,
  )
  await assert.rejects(
    f.assets.uploadImage(upload(f.session.id, { mimeType: 'image/jpeg' })),
    /格式不符/,
  )
  await assert.rejects(
    f.assets.uploadImage(upload(f.session.id, { mimeType: 'image/svg+xml' })),
    /无效/,
  )
  await assert.rejects(
    f.assets.uploadImage(
      upload(f.session.id, {
        base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64'),
      }),
    ),
    /过大|无效/,
  )
  const asset = await f.assets.uploadImage(upload(f.session.id))
  const other = f.store.sessions.create(null)
  assert.throws(
    () => userContentParts(f.store, other.id, 'text', [asset.assetId]),
    /当前会话/,
  )
  assert.throws(
    () =>
      userContentParts(f.store, f.session.id, 'text', [
        asset.assetId,
        asset.assetId,
      ]),
    /不能重复/,
  )
  assert.throws(
    () =>
      userContentParts(f.store, f.session.id, 'text', [
        'a',
        'b',
        'c',
        'd',
        'e',
      ]),
    /最多/,
  )
  await assert.rejects(
    resolveModelImages(
      f.store,
      other.id,
      [
        {
          role: 'user',
          content: '',
          images: [
            { type: 'image', assetId: asset.assetId, mimeType: 'image/png' },
          ],
        },
      ],
      new AbortController().signal,
    ),
    /当前会话/,
  )
  rmSync(join(f.dir, 'assets', 'sessions', f.session.id, asset.assetId))
  await assert.rejects(
    resolveModelImages(
      f.store,
      f.session.id,
      [
        {
          role: 'user',
          content: '',
          images: [
            { type: 'image', assetId: asset.assetId, mimeType: 'image/png' },
          ],
        },
      ],
      new AbortController().signal,
    ),
    /丢失/,
  )
})

test('queue edits retain attachments and snapshots contain references only', () => {
  const events = []
  const queue = new QueueService((event) => events.push(event))
  const params = CommandSchemaRegistry['message.send'].params.parse({
    requestId: 'test',
    sessionId: 's',
    content: 'describe',
    imageAssetIds: ['image'],
  })
  const entry = queue.enqueue('s', params)
  assert.deepEqual(queue.list('s')[0].imageAssetIds, ['image'])
  queue.update('s', entry.id, { ...entry.params, content: 'edited' })
  assert.deepEqual(queue.dequeue('s').params.imageAssetIds, ['image'])
  assert.ok(!JSON.stringify(events).includes('base64'))
})

test('session deletion cascades uploaded metadata and removes image files', async (t) => {
  const f = fixture(t)
  const asset = await f.assets.uploadImage(upload(f.session.id))
  const path = join(f.dir, 'assets', 'sessions', f.session.id, asset.assetId)
  assert.ok(existsSync(path))
  f.store.sessions.delete(f.session.id)
  await f.assets.deleteSessionDir(f.session.id)
  assert.equal(f.store.assetStore.get(asset.assetId), null)
  assert.equal(existsSync(path), false)
})

test('v38 assets migrate without losing existing project files', async (t) => {
  const f = fixture(t)
  const project = f.store.projects.create({
    name: 'project',
    folderPath: f.dir,
  })
  writeFileSync(join(f.dir, 'image.png'), Buffer.from(png, 'base64'))
  const original = await f.assets.importWorkspace(project.id, 'image.png')
  const db = new DatabaseSync(join(f.dir, 'reflexion.db'))
  db.exec('ALTER TABLE assets DROP COLUMN session_id; PRAGMA user_version = 38')
  db.close()
  const upgraded = new Store(f.dir)
  try {
    assert.equal(
      upgraded.assetStore.get(original.assetId).projectId,
      project.id,
    )
    assert.equal(
      (await new AssetService(upgraded, f.dir).read(original.assetId)).base64,
      png,
    )
    const session = upgraded.sessions.create(null)
    assert.equal(
      (await new AssetService(upgraded, f.dir).uploadImage(upload(session.id)))
        .sessionId,
      session.id,
    )
  } finally {
    upgraded.close()
  }
})

test('workspace import rejects credential names and internal symlinks to credentials before reading', async (t) => {
  const f = fixture(t)
  const workspace = join(f.dir, 'workspace')
  mkdirSync(workspace)
  const project = f.store.projects.create({
    name: 'project',
    folderPath: workspace,
  })
  // Empty synthetic files only; no credential contents are read or written.
  writeFileSync(join(workspace, '.env.test'), '')
  await assert.rejects(
    f.assets.importWorkspace(project.id, '.env.test'),
    /机密/,
  )
  symlinkSync(join(workspace, '.env.test'), join(workspace, 'innocent.png'))
  await assert.rejects(
    f.assets.importWorkspace(project.id, 'innocent.png'),
    /机密/,
  )
})

for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${format}: actual HTTP request includes native image blocks and preserves plain text`, async () => {
    let body
    const server = await startServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        body = JSON.parse(raw)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (format === 'openai-chat')
          response.end(
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          )
        else if (format === 'openai-responses')
          response.end(
            'data: {"type":"response.completed","item":{"status":"completed"}}\n\n',
          )
        else
          response.end(
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
          )
      })
    })
    try {
      await streamChat(
        {
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: 'test',
          model: 'vision-model',
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'plain' },
            {
              role: 'user',
              content: 'describe',
              images: [
                {
                  type: 'image',
                  assetId: 'image',
                  mimeType: 'image/png',
                  base64: png,
                },
              ],
            },
          ],
          signal: new AbortController().signal,
        },
        format,
        () => {},
      )
      const messages =
        format === 'openai-responses'
          ? body.input
          : body.messages.filter((msg) => msg.role !== 'system')
      assert.equal(messages[0].content, 'plain')
      const [image, text] = messages[1].content
      assert.equal(text.text, 'describe')
      if (format === 'anthropic')
        assert.deepEqual(image, {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png },
        })
      else if (format === 'openai-chat')
        assert.deepEqual(image, {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${png}`, detail: 'auto' },
        })
      else
        assert.deepEqual(image, {
          type: 'input_image',
          image_url: `data:image/png;base64,${png}`,
          detail: 'auto',
        })
      assert.equal(JSON.stringify(body).includes('assetId'), false)
    } finally {
      server.close()
      server.closeAllConnections()
    }
  })
}

test('queued images cannot be deleted until their queue entry is removed', async (t) => {
  const f = fixture(t)
  const image = await f.assets.uploadImage(upload(f.session.id))
  const queue = new QueueService(() => {})
  const entry = queue.enqueue(f.session.id, {
    content: 'queued',
    imageAssetIds: [image.assetId],
  })
  const ctx = {
    assets: f.assets,
    store: f.store,
    agent: {
      listQueue: (id) => ({ items: queue.list(id) }),
    },
  }
  await assert.rejects(
    assetCommandHandlers['asset.delete']({ assetId: image.assetId }, ctx),
    /排队/,
  )
  assert.equal((await f.assets.read(image.assetId)).base64, png)
  queue.remove(f.session.id, entry.id)
  assert.equal(
    (
      await assetCommandHandlers['asset.delete'](
        { assetId: image.assetId },
        ctx,
      )
    ).removed,
    true,
  )
})

test('deletion removes metadata before disk IO can race with message send', async (t) => {
  const f = fixture(t)
  const image = await f.assets.uploadImage(upload(f.session.id))
  const deleting = f.assets.delete(image.assetId)
  assert.equal(f.store.assetStore.get(image.assetId), null)
  assert.throws(() =>
    userContentParts(f.store, f.session.id, 'hello', [image.assetId]),
  )
  await deleting
})

test('image reads reject oversized content and symbolic links', async (t) => {
  const f = fixture(t)
  const image = await f.assets.uploadImage(upload(f.session.id))
  const path = join(f.dir, 'assets', 'sessions', f.session.id, image.assetId)
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1))
  assert.equal((await f.assets.read(image.assetId)).base64, null)
  rmSync(path)
  const target = join(f.dir, 'ordinary-image.png')
  writeFileSync(target, Buffer.from(png, 'base64'))
  try {
    symlinkSync(target, path)
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable')
      return
    }
    throw error
  }
  assert.equal((await f.assets.read(image.assetId)).base64, null)
})

test('uploaded screenshots remain readable when Store uses the configured data directory', async (t) => {
  const f = fixture(t)
  const previous = process.env.REFLEXION_DATA_DIR
  process.env.REFLEXION_DATA_DIR = realpathSync(f.dir)
  try {
    const image = await f.assets.uploadImage(upload(f.session.id))
    assert.equal((await f.assets.read(image.assetId)).base64, png)
    const messages = [
      {
        role: 'user',
        content: 'describe screenshot',
        images: [
          { type: 'image', assetId: image.assetId, mimeType: image.mimeType },
        ],
      },
    ]
    const hydrated = await resolveModelImages(
      f.store,
      f.session.id,
      messages,
      new AbortController().signal,
    )
    assert.equal(hydrated[0].images[0].base64, png)
  } finally {
    if (previous === undefined) delete process.env.REFLEXION_DATA_DIR
    else process.env.REFLEXION_DATA_DIR = previous
  }
})
