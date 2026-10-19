import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import { Store } from '../dist/store/index.js'
import { AssetService } from '../dist/assets/service.js'
import {
  userContentParts,
  messageAttachmentIds,
} from '../dist/agent/context/image-parts.js'
import { reconstructSessionFrames } from '../dist/agent/context/context-frames.js'
import { createChatArchive } from '../dist/chat/archive/export.js'
import { importChatArchive } from '../dist/chat/archive/import.js'
import { assetCommandHandlers } from '../dist/assets/handlers.js'
import { QueueService } from '../dist/agent/session/queue.js'
import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'attachments-'))
  const store = new Store(dir)
  const assets = new AssetService(store, dir)
  const session = store.sessions.create(null)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const upload = (fileName, data) =>
    assets.uploadDocument({
      sessionId: session.id,
      fileName,
      base64: Buffer.from(data).toString('base64'),
    })
  return { dir, store, assets, session, upload }
}
function docx(text) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text}</w:body></w:document>`,
    ),
  })
}
function pdf(pages) {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, text] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    )
    const stream = text ? `BT /F1 12 Tf 30 260 Td (${text}) Tj ET` : ''
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let result = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 1; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(result))
    result += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const start = Buffer.byteLength(result)
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(result)
}
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

test('text attachments persist, preview extracted lines and enter model context after restart', async (t) => {
  const f = fixture(t)
  const asset = await f.upload('example.ts', 'const value = 1\n// 你好')
  const parts = userContentParts(f.store, f.session.id, 'explain', [
    asset.assetId,
  ])
  assert.equal(parts[1].type, 'file')
  assert.equal(parts[1].extraction.text, '1: const value = 1\n2: // 你好')
  f.store.messages.create({
    sessionId: f.session.id,
    runId: null,
    role: 'user',
    content: 'explain',
    parts,
    status: 'completed',
  })
  assert.equal(
    (await f.assets.read(asset.assetId)).text,
    parts[1].extraction.text,
  )
  await assert.rejects(f.assets.delete(asset.assetId), /不能删除/)
  const reopened = new Store(f.dir)
  try {
    const frames = reconstructSessionFrames(reopened, f.session.id, 'system')
    assert.match(frames[1].content, /example.ts/)
    assert.match(frames[1].content, /2: \/\/ 你好/)
    assert.match(frames[1].content, /不可信/)
    assert.deepEqual(
      reopened.messages.listBySession(f.session.id)[0].parts,
      parts,
    )
  } finally {
    reopened.close()
  }
})

test('PDF preserves page labels and DOCX preserves paragraphs and table text', async (t) => {
  const f = fixture(t)
  const pdfAsset = await f.upload(
    'paper.pdf',
    pdf(['First page', 'Second page']),
  )
  const extracted = pdfAsset.metadata.extraction
  assert.equal(extracted.pages, 2)
  assert.match(extracted.text, /第 1 页.*\nFirst page/)
  assert.match(extracted.text, /第 2 页.*\nSecond page/)
  const word = await f.upload(
    'paper.docx',
    docx(
      '<w:p><w:r><w:t>标题 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
  )
  assert.match(word.metadata.extraction.text, /标题 & 内容\n单元格/)
  await assert.rejects(f.upload('scan.pdf', pdf([''])), /OCR/)
  await assert.rejects(f.upload('mixed.pdf', pdf(['Text', ''])), /第 2 页.*OCR/)
  await assert.rejects(f.upload('empty.docx', docx('<w:p/>')), /没有可提取文字/)
})

test('invalid, oversized, sensitive and binary uploads fail without leaving assets', async (t) => {
  const f = fixture(t)
  for (const name of [
    '.env',
    '.env.local',
    'credentials.json',
    'secrets.json',
    'id_rsa.txt',
    '../code.ts',
    'folder\\code.ts',
  ])
    await assert.rejects(f.upload(name, 'sensitive'), /敏感|文件名/)
  await assert.rejects(f.upload('legacy.doc', 'data'), /不支持 DOC/)
  await assert.rejects(f.upload('binary.ts', Buffer.from([0, 1, 2])), /二进制/)
  await assert.rejects(f.upload('encoding.txt', Buffer.from([255])), /UTF-8/)
  await assert.rejects(f.upload('big.txt', 'a'.repeat(60_001)), /60000/)
  await assert.rejects(
    f.upload('big.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)),
    /格式或大小无效|10MB/,
  )
  await assert.rejects(f.upload('fake.pdf', 'hello'), /PDF/)
  await assert.rejects(f.upload('bad.docx', 'hello'), /损坏|解析/)
  const bomb = docx(
    `<w:p><w:r><w:t>${'a'.repeat(9 * 1024 * 1024)}</w:t></w:r></w:p>`,
  )
  await assert.rejects(f.upload('bomb.docx', bomb), /解压/)
  assert.equal(f.store.assetStore.all().length, 0)
})

test('four total attachments applies to mixed/legacy IDs, duplicates and foreign sessions', async (t) => {
  const f = fixture(t)
  const file = await f.upload('one.txt', 'one')
  const image = await f.assets.uploadImage({
    sessionId: f.session.id,
    fileName: 'pixel.png',
    mimeType: 'image/png',
    base64: png,
  })
  assert.equal(
    userContentParts(f.store, f.session.id, '', [file.assetId, image.assetId])
      .length,
    2,
  )
  assert.throws(
    () =>
      userContentParts(f.store, f.session.id, '', [file.assetId, file.assetId]),
    /不能重复/,
  )
  assert.throws(
    () =>
      userContentParts(
        f.store,
        f.session.id,
        '',
        messageAttachmentIds({
          attachmentAssetIds: Array(4).fill(file.assetId),
          imageAssetIds: [image.assetId],
        }),
      ),
    /最多 4 个文件/,
  )
  const foreign = f.store.sessions.create(null)
  assert.throws(
    () => userContentParts(f.store, foreign.id, '', [file.assetId]),
    /不属于/,
  )
  assert.equal(
    CommandSchemaRegistry['message.send'].params.safeParse({
      requestId: 'r',
      sessionId: f.session.id,
      content: 'x',
      attachmentAssetIds: Array(5).fill('a'),
    }).success,
    false,
  )
  const queue = new QueueService(() => {})
  queue.enqueue(f.session.id, {
    content: 'analyze',
    attachmentAssetIds: [file.assetId],
  })
  assert.deepEqual(queue.list(f.session.id)[0].attachmentAssetIds, [
    file.assetId,
  ])
  await assert.rejects(
    assetCommandHandlers['asset.delete'](
      { assetId: file.assetId },
      {
        assets: f.assets,
        store: f.store,
        agent: { listQueue: () => ({ items: queue.list(f.session.id) }) },
      },
    ),
    /排队/,
  )
})

test('document and image archives round trip bytes and extracted context', async (t) => {
  const f = fixture(t)
  const file = await f.upload(
    'notes.docx',
    docx('<w:p><w:r><w:t>Archive text</w:t></w:r></w:p>'),
  )
  const image = await f.assets.uploadImage({
    sessionId: f.session.id,
    fileName: 'pixel.png',
    mimeType: 'image/png',
    base64: png,
  })
  f.store.messages.create({
    sessionId: f.session.id,
    runId: null,
    role: 'user',
    content: 'analyze',
    parts: userContentParts(f.store, f.session.id, 'analyze', [
      file.assetId,
      image.assetId,
    ]),
    status: 'completed',
  })
  const archive = await createChatArchive(f, f.session.id)
  assert.equal(archive.files.length, 1)
  const restored = await importChatArchive(
    {
      ...f,
      system: {
        available: true,
        request: async () => ({
          content: JSON.stringify(archive),
          path: '/tmp/chat.reflexion-chat.json',
        }),
      },
    },
    { path: '/tmp/chat.reflexion-chat.json' },
  )
  const parts = f.store.messages.listBySession(restored.session.id)[0].parts
  const document = parts.find((part) => part.type === 'file')
  assert.equal(document.extraction.text, 'Archive text')
  assert.notEqual(document.assetId, file.assetId)
  assert.equal(
    await f.assets.readDocumentBytes(document.assetId),
    await f.assets.readDocumentBytes(file.assetId),
  )
  assert.match(
    reconstructSessionFrames(f.store, restored.session.id, 'sys')[1].content,
    /Archive text/,
  )
})

test('standalone bundled document worker parses PDF and DOCX without node_modules or stdout output', async (t) => {
  const { build } = await import('esbuild')
  const { Worker } = await import('node:worker_threads')
  const directory = mkdtempSync(join(tmpdir(), 'document-worker-bundle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const outfile = join(directory, 'document-worker.mjs')
  await build({
    entryPoints: [
      new URL('../src/assets/documents/worker.ts', import.meta.url).pathname,
    ],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['node:*'],
    banner: {
      js: "import { createRequire as __documentCreateRequire } from 'node:module'; const require = __documentCreateRequire(import.meta.url)",
    },
  })
  for (const [format, bytes] of [
    ['pdf', pdf(['Bundled PDF'])],
    ['docx', docx('<w:p><w:r><w:t>Bundled DOCX</w:t></w:r></w:p>')],
  ]) {
    const worker = new Worker(outfile, {
      workerData: { format, bytes: new Uint8Array(bytes) },
      stdout: true,
      stderr: true,
      execArgv: [],
    })
    let stdout = ''
    worker.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    worker.stderr.resume()
    try {
      const message = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('bundle timeout')),
          15_000,
        )
        worker.once('message', (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        worker.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      assert.equal(message.error, undefined)
      assert.match(message.result.text, /Bundled/)
      assert.equal(stdout, '')
    } finally {
      await worker.terminate()
    }
  }
})
