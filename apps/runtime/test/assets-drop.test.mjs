import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  CommandSchemaRegistry,
} from '@reflexion-os-studio/contracts'
import { readDroppedLocalFile } from '../dist/assets/drop/local-file.js'
import { assetCommandHandlers } from '../dist/assets/handlers.js'
import { dispatchCommand } from '../dist/handlers.js'

/**
 * asset.read_dropped_file：系统文件管理器拖入窗口的本地文件读取。
 * 路径来自用户拖放手势，可能在工作区之外，因此这里只测四条硬边界——
 * 类型白名单、大小上限、no-read 凭据清单（含软链接）、普通文件与绝对路径。
 */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dropped-file-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name, content) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }
  return { dir, write }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('预期拒绝，但调用成功了')
}

test('read_dropped_file: 文本/图片/PDF 按扩展名给出 mime 与原始字节', async (t) => {
  const { write } = fixture(t)
  const text = write('会议纪要.md', '# 记录\n第二行\n')
  const droppedText = await readDroppedLocalFile(text)
  assert.equal(droppedText.fileName, '会议纪要.md')
  assert.equal(droppedText.mimeType, 'text/plain')
  assert.equal(droppedText.size, Buffer.byteLength('# 记录\n第二行\n'))
  assert.equal(
    Buffer.from(droppedText.base64, 'base64').toString('utf8'),
    '# 记录\n第二行\n',
  )

  const image = write('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const droppedImage = await readDroppedLocalFile(image)
  assert.equal(droppedImage.mimeType, 'image/png')
  assert.equal(droppedImage.size, 4)

  const pdf = write('合同.PDF', '%PDF-1.7\n')
  assert.equal((await readDroppedLocalFile(pdf)).mimeType, 'application/pdf')

  // 扩展名大小写不敏感。
  const docx = write('提纲.DOCX', 'x')
  assert.equal(
    (await readDroppedLocalFile(docx)).mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
})

test('read_dropped_file: 相对路径、控制字符与目录一律拒绝', async (t) => {
  const { dir, write } = fixture(t)
  write('plain.txt', 'ok')

  const relative = await rejection(readDroppedLocalFile('plain.txt'))
  assert.equal(relative.code, 'invalid_request')
  assert.match(relative.message, /绝对路径/)

  const control = await rejection(readDroppedLocalFile(`${dir}/a\u0001b.txt`))
  assert.equal(control.code, 'invalid_request')

  const folder = await rejection(readDroppedLocalFile(dir))
  assert.equal(folder.code, 'invalid_request')
  assert.match(folder.message, /普通文件/)

  const missing = await rejection(readDroppedLocalFile(join(dir, 'nope.txt')))
  assert.equal(missing.code, 'invalid_request')
  assert.match(missing.message, /不存在/)
})

test('read_dropped_file: 类型白名单与空文件/超限拒绝', async (t) => {
  const { dir, write } = fixture(t)

  const doc = await rejection(readDroppedLocalFile(write('旧格式.doc', 'x')))
  assert.equal(doc.code, 'invalid_request')
  assert.match(doc.message, /不支持的文件类型/)

  const binary = await rejection(
    readDroppedLocalFile(write('setup.exe', Buffer.from([0x4d, 0x5a]))),
  )
  assert.equal(binary.code, 'invalid_request')

  // 无扩展名的文件同样不能借白名单漏洞进入。
  const noExtension = await rejection(
    readDroppedLocalFile(write('noext', 'raw')),
  )
  assert.match(noExtension.message, /无扩展名/)

  const empty = await rejection(readDroppedLocalFile(write('empty.txt', '')))
  assert.match(empty.message, /文件为空/)

  // 图片上限 4MB：多出 1 字节即拒绕，且不把内容回显进错误。
  const big = join(dir, 'huge.png')
  writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1))
  const oversize = await rejection(readDroppedLocalFile(big))
  assert.equal(oversize.code, 'invalid_request')
  assert.match(oversize.message, /文件过大/)

  // 图片上限与文档上限按类型分开判定，不能互相放宽。
  const almostOk = join(dir, 'almost-ok.png')
  writeFileSync(almostOk, Buffer.alloc(MAX_IMAGE_BYTES - 1))
  assert.equal((await readDroppedLocalFile(almostOk)).size, MAX_IMAGE_BYTES - 1)

  const bigText = join(dir, 'huge.txt')
  writeFileSync(bigText, Buffer.alloc(MAX_DOCUMENT_BYTES + 1))
  assert.match(
    (await rejection(readDroppedLocalFile(bigText))).message,
    /文件过大/,
  )
})

test('read_dropped_file: no-read 凭据清单拦截，含软链接指向', async (t) => {
  const { dir, write } = fixture(t)

  // 直连凭据文件名。
  const secret = write('secrets.json', '{"token":"x"}')
  const direct = await rejection(readDroppedLocalFile(secret))
  assert.equal(direct.code, 'invalid_request')
  assert.match(direct.message, /禁止读取凭据/)

  const env = await rejection(readDroppedLocalFile(write('.env.local', 'A=1')))
  assert.match(env.message, /禁止读取凭据/)

  const credentials = await rejection(
    readDroppedLocalFile(write('credentials.json', '{}')),
  )
  assert.match(credentials.message, /禁止读取凭据/)

  // 名字看着像无害文本、实际按 no-read 清单也会被拦。
  const keyLike = await rejection(
    readDroppedLocalFile(write('id_rsa.txt', 'x')),
  )
  assert.match(keyLike.message, /禁止读取凭据/)

  const pem = await rejection(readDroppedLocalFile(write('server.pem', 'k')))
  assert.match(pem.message, /禁止读取凭据/)

  // 软链接伪装：无害文件名 → 真实凭据文件，realpath 复核后必须拒绝。
  const secretDir = join(dir, 'vault')
  mkdirSync(secretDir)
  const target = join(secretDir, 'secrets.json')
  writeFileSync(target, '{"k":"v"}')
  const linkDir = join(dir, 'looks-harmless')
  mkdirSync(linkDir)
  const link = join(linkDir, 'private.txt')
  symlinkSync(target, link)
  const viaLink = await rejection(readDroppedLocalFile(link))
  assert.equal(viaLink.code, 'invalid_request')
  assert.match(viaLink.message, /禁止读取凭据/)

  // 平台敏感根（~/.ssh 等）下的任何文件同样拒绝，且不因后缀无害而放行。
  const sshPath = join(homedir(), '.ssh', 'notes.txt')
  const sensitiveRoot = await rejection(readDroppedLocalFile(sshPath))
  assert.equal(sensitiveRoot.code, 'invalid_request')
  assert.match(sensitiveRoot.message, /禁止读取凭据/)
})

test('read_dropped_file: 命令已注册到契约与 asset 命令表', async () => {
  assert.ok(
    CommandSchemaRegistry['asset.read_dropped_file'],
    '契约缺少 asset.read_dropped_file',
  )
  assert.equal(
    typeof assetCommandHandlers['asset.read_dropped_file'],
    'function',
  )

  const { dir, write } = fixture({ after: () => {} })
  const path = write('note.txt', 'hi')
  const result = await assetCommandHandlers['asset.read_dropped_file']({ path })
  assert.equal(result.fileName, 'note.txt')
  assert.equal(Buffer.from(result.base64, 'base64').toString('utf8'), 'hi')
  rmSync(dir, { recursive: true, force: true })
})

test('read_dropped_file: dispatchCommand 校验参数且不回显内容', async () => {
  const { dir, write } = fixture({ after: () => {} })
  const path = write('via-dispatch.txt', 'hello')
  const result = await dispatchCommand(
    'asset.read_dropped_file',
    { path },
    { store: null, agent: null, assets: null },
  )
  assert.equal(result.fileName, 'via-dispatch.txt')
  assert.equal(Buffer.from(result.base64, 'base64').toString(), 'hello')

  await assert.rejects(
    dispatchCommand('asset.read_dropped_file', {}, { store: null }),
    /invalid_request|required|path/,
  )
  rmSync(dir, { recursive: true, force: true })
})
