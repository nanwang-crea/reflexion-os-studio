import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../dist/store/index.js'
import { AssetService } from '../dist/assets/service.js'
import { createChatArchive } from '../dist/chat/archive/export.js'
import { importChatArchive } from '../dist/chat/archive/import.js'
import { dispatchCommand } from '../dist/handlers.js'
import { normalizeToolOutput } from '../dist/agent/run/toolResults.js'
import {
  reconstructSessionFrames,
  framesToValidatedMessages,
} from '../dist/agent/context/context-frames.js'
import { restoreFileWrites } from '../dist/agent/tools/file-writing/state.js'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-archive-test-'))
  const store = new Store(join(root, 'data'))
  const assets = new AssetService(store, join(root, 'data'))
  let content = ''
  const system = {
    available: true,
    request: async (_, params) => {
      if (params.action === 'read')
        return { path: join(params.workspaceRoot, params.path), content }
      if (params.action === 'directory') return { path: params.workspaceRoot }
      content = params.content
      return { path: join(params.workspaceRoot, params.path) }
    },
  }
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    store,
    assets,
    system,
    load: (archive) => {
      content = JSON.stringify(archive)
    },
  }
}
async function source(ctx) {
  const session = ctx.store.sessions.create(null, '往返测试')
  const image = await ctx.assets.uploadImage({
    sessionId: session.id,
    fileName: 'image.png',
    mimeType: 'image/png',
    base64: png,
  })
  const run = ctx.store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: 'recorded-model',
  })
  ctx.store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '你好',
    status: 'completed',
    parts: [
      { type: 'text', text: '你好' },
      { type: 'image', assetId: image.assetId, mimeType: 'image/png' },
    ],
  })
  const assistant = ctx.store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '已完成',
    status: 'completed',
  })
  ctx.store.messages.finalize(assistant.id, '已完成', 'completed', '一段思考')
  const call = ctx.store.toolCalls.create({
    runId: run.id,
    messageId: assistant.id,
    toolName: 'file.write_stream',
    args: { action: 'begin', path: 'out.txt' },
  })
  ctx.store.toolCalls.finalize(
    call.id,
    'completed',
    normalizeToolOutput(
      {
        content: '保存成功',
        isError: false,
        data: { fileWriteCheckpoint: { private: 'must-not-be-restored' } },
      },
      null,
      'file.write_stream',
    ),
  )
  ctx.store.runs.finalize(run.id, 'completed')
  return { session, image, call, run }
}

test('portable history round trips images, reasoning and tool text into a new independent session', async (t) => {
  const ctx = fixture(t)
  const original = await source(ctx)
  const archive = await createChatArchive(ctx, original.session.id)
  assert.doesNotMatch(
    JSON.stringify(archive),
    /fileWriteCheckpoint|providerContinuation|approvalGrantId/,
  )
  ctx.load(archive)
  const imported = await importChatArchive(ctx, {
    path: join(ctx.root, 'saved.reflexion-chat.json'),
  })
  assert.notEqual(imported.session.id, original.session.id)
  assert.equal(imported.session.projectId, null)
  const messages = ctx.store.messages.listBySession(imported.session.id)
  assert.deepEqual(
    messages.map((m) => m.content),
    ['你好', '已完成'],
  )
  assert.equal(messages[1].reasoning, '一段思考')
  assert.equal(messages[0].createdAt, archive.messages[0].createdAt)
  assert.notEqual(messages[0].parts[1].assetId, original.image.assetId)
  assert.equal(
    (await ctx.assets.read(messages[0].parts[1].assetId)).base64,
    png,
  )
  const calls = ctx.store.toolCalls.listBySession(imported.session.id)
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].id, original.call.id)
  assert.equal(calls[0].output.content, '保存成功')
  assert.equal(calls[0].output.data, null)
  assert.deepEqual(calls[0].output.changedFiles, [])
  assert.equal(restoreFileWrites(ctx.store, imported.session.id).size, 0)
  assert.equal(
    ctx.store.runs.listBySession(imported.session.id)[0].providerId,
    null,
  )
  framesToValidatedMessages(
    reconstructSessionFrames(ctx.store, imported.session.id, 'system'),
  )
  const again = await createChatArchive(ctx, imported.session.id)
  assert.deepEqual(
    again.messages.map(({ content, reasoning }) => ({ content, reasoning })),
    archive.messages.map(({ content, reasoning }) => ({ content, reasoning })),
  )
})

test('all model turns of an original Run remain grouped under one new Run', async (t) => {
  const ctx = fixture(t)
  const { session, run } = await source(ctx)
  const archive = await createChatArchive(ctx, session.id)
  archive.messages.push({
    ...archive.messages[1],
    content: '最终答复',
    tools: [],
  })
  ctx.load(archive)
  const imported = await importChatArchive(ctx, {
    path: join(ctx.root, 'saved.reflexion-chat.json'),
  })
  const messages = ctx.store.messages.listBySession(imported.session.id)
  assert.equal(messages.length, 3)
  assert.equal(new Set(messages.map((message) => message.runId)).size, 1)
  assert.notEqual(messages[0].runId, run.id)
  assert.equal(ctx.store.runs.listBySession(imported.session.id).length, 1)
  framesToValidatedMessages(
    reconstructSessionFrames(ctx.store, imported.session.id, 'system'),
  )
})

test('directory import reuses a project or creates one, with request receipts preventing duplicate imports', async (t) => {
  const ctx = fixture(t)
  const { session } = await source(ctx)
  ctx.load(await createChatArchive(ctx, session.id))
  const folderPath = join(ctx.root, 'target')
  const params = {
    requestId: 'import-once',
    path: join(ctx.root, 'saved.reflexion-chat.json'),
    folderPath,
  }
  const [a, b] = await Promise.all([
    dispatchCommand('session.archive.import', params, ctx),
    dispatchCommand('session.archive.import', params, ctx),
  ])
  assert.equal(a.session.id, b.session.id)
  const project = ctx.store.projects.findByFolderPath(folderPath)
  assert.equal(a.session.projectId, project.id)
  assert.equal(ctx.store.sessions.list(project.id).length, 1)
  const next = await importChatArchive(ctx, { path: params.path, folderPath })
  assert.equal(next.session.projectId, project.id)
  assert.equal(ctx.store.projects.list().length, 1)
  const chosen = await importChatArchive(ctx, {
    path: params.path,
    projectId: project.id,
  })
  assert.equal(chosen.session.projectId, project.id)
})

test('directory aliases resolve to the already associated physical project', async (t) => {
  const ctx = fixture(t)
  const { session } = await source(ctx)
  ctx.load(await createChatArchive(ctx, session.id))
  const alias = join(ctx.root, 'alias')
  const physical = join(ctx.root, 'physical')
  const project = ctx.store.projects.create({
    name: 'existing',
    folderPath: alias,
  })
  const request = ctx.system.request
  ctx.system.request = async (method, params) =>
    params.action === 'directory' && params.workspaceRoot === alias
      ? { path: physical }
      : request(method, params)
  const imported = await importChatArchive(ctx, {
    path: join(ctx.root, 'saved.reflexion-chat.json'),
    folderPath: physical,
  })
  assert.equal(imported.session.projectId, project.id)
  assert.equal(ctx.store.projects.list().length, 1)
})

test('invalid archives and targets leave no sessions or projects', async (t) => {
  const ctx = fixture(t)
  const { session } = await source(ctx)
  const valid = await createChatArchive(ctx, session.id)
  for (const change of [
    (a) => {
      a.version = 99
    },
    (a) => {
      a.messages[0].role = 'system'
    },
    (a) => {
      a.messages[0].images = ['missing']
    },
    (a) => {
      a.messages[0].tools = a.messages[1].tools
    },
    (a) => {
      a.images[0].mimeType = 'image/jpeg'
    },
  ]) {
    const archive = structuredClone(valid)
    change(archive)
    ctx.load(archive)
    await assert.rejects(
      importChatArchive(ctx, {
        path: join(ctx.root, 'bad.reflexion-chat.json'),
        folderPath: join(ctx.root, 'target'),
      }),
    )
    assert.equal(ctx.store.sessions.list().length, 1)
    assert.equal(ctx.store.projects.list().length, 0)
  }
  ctx.load(valid)
  await assert.rejects(
    importChatArchive(ctx, {
      path: join(ctx.root, 'ok.reflexion-chat.json'),
      projectId: 'missing',
    }),
    /目标项目不存在/,
  )
  await assert.rejects(
    importChatArchive(ctx, { path: join(ctx.root, '.env') }),
    /聊天备份/,
  )
})

test('partial image failure and database failure compensate session, images and newly created project', async (t) => {
  const ctx = fixture(t)
  const { session } = await source(ctx)
  const archive = await createChatArchive(ctx, session.id)
  archive.images.push({ ...archive.images[0], id: 'second-image' })
  archive.messages[0].images.push('second-image')
  ctx.load(archive)
  const upload = ctx.assets.uploadImage.bind(ctx.assets)
  let count = 0
  let transientSession
  ctx.assets.uploadImage = async (input) => {
    transientSession = input.sessionId
    if (++count === 2) throw new Error('injected write failure')
    return upload(input)
  }
  await assert.rejects(
    importChatArchive(ctx, {
      path: join(ctx.root, 'ok.reflexion-chat.json'),
      folderPath: join(ctx.root, 'new'),
    }),
    /injected/,
  )
  assert.equal(ctx.store.sessions.list().length, 1)
  assert.equal(ctx.store.projects.list().length, 0)
  assert.equal(
    existsSync(join(ctx.root, 'data', 'assets', 'sessions', transientSession)),
    false,
  )
  ctx.assets.uploadImage = upload
  ctx.store.chatArchives.restore = () => {
    throw new Error('injected db failure')
  }
  await assert.rejects(
    importChatArchive(ctx, { path: join(ctx.root, 'ok.reflexion-chat.json') }),
    /injected db/,
  )
  assert.equal(ctx.store.sessions.list().length, 1)
})

const binary = resolveSystemRuntimeBinary()
test(
  'real sidecar exports to a directory and imports the resulting UTF-8 backup',
  { skip: binary === null },
  async (t) => {
    const ctx = fixture(t)
    const client = new SystemRuntimeClient(binary, [], () => {})
    client.start()
    t.after(() => client.shutdown())
    const deadline = Date.now() + 10_000
    while (!client.available && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    ctx.system = client
    const { session, run } = await source(ctx)
    const out = await dispatchCommand(
      'session.archive.export',
      { requestId: 'export-once', sessionId: session.id, directory: ctx.root },
      ctx,
    )
    assert.ok(existsSync(out.path))
    assert.equal(JSON.parse(readFileSync(out.path, 'utf8')).title, '往返测试')
    const imported = await importChatArchive(ctx, {
      path: out.path,
      folderPath: ctx.root,
    })
    assert.equal(imported.messageCount, 2)
    assert.equal(
      ctx.store.projects.get(imported.session.projectId).folderPath,
      await import('node:fs').then((fs) => fs.realpathSync(ctx.root)),
    )
    const invalid = join(ctx.root, 'bad.reflexion-chat.json')
    writeFileSync(invalid, '{"version":99}')
    await assert.rejects(importChatArchive(ctx, { path: invalid }))
    ctx.store.runs.finalize(run.id, 'running')
    await assert.rejects(createChatArchive(ctx, session.id), /停止回复/)
  },
)
