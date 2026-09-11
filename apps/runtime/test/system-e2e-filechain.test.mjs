import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'

/**
 * 回归测试：先读后改凭据链路（真实二进制端到端）。
 *
 * 历史 bug：Rust 的 file.read 响应缺 revision（mtime+size+sha256）嵌套字段，
 * TS 层 extractRevision 提取不到 → FileReadState 不登记 → 对既有文件的
 * file.edit / file.write 必然被拒（"尚未在本轮读取" / "refusing to
 * overwrite"），且报错给出的补救（先 file.read）永远无法生效——死锁。
 *
 * fake fixture 测不到这条协议缝：TS 测试的 fake 本就返回 revision 三字段，
 * Rust 单测手工构造 Revision 绕过了 JSON handler。本测试直接跑真实二进制
 * 走 JSON-RPC，验证 read 发放的凭据能真正授权 edit / write。
 * 无二进制的环境（clean checkout 未构建）跳过，不误报。
 */

const BINARY = resolveSystemRuntimeBinary()

function makeGrant(workspaceRoot, operation) {
  return JSON.stringify({
    grantId: `grant-${operation}`,
    requestId: 'req-e2e-filechain',
    sessionId: 'sess-e2e-filechain',
    workspaceId: workspaceRoot,
    operation,
    scope: 'session',
    expiresAt: Date.now() + 60_000,
  })
}

async function waitReady(client) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (client.available) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('system runtime not ready within 10s')
}

test(
  'file.read issues revision credentials authorizing file.edit and file.write',
  { skip: BINARY === null },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-filechain-'))
    const target = join(workspace, 'note.txt')
    // Run 前既已存在的文件（不经 file.write 创建），先读后改约束的真实场景。
    writeFileSync(target, 'hello\nworld\n')

    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)

      // 1. file.read 响应必须携带嵌套 revision（回归点：此前缺失此字段）。
      const read = await client.request('file.read', {
        workspaceRoot: workspace,
        path: 'note.txt',
      })
      assert.equal(read.readComplete, true)
      assert.ok(
        read.revision,
        'file.read response must carry nested revision credential',
      )
      assert.equal(read.revision.modifiedMs, read.modifiedMs)
      assert.equal(read.revision.sizeBytes, read.sizeBytes)
      assert.match(read.revision.sha256, /^[0-9a-f]{64}$/)

      // 2. read 发放的凭据直接授权 file.edit（修复前必拒：尚未在本轮读取）。
      const edit = await client.request('file.edit', {
        workspaceRoot: workspace,
        path: 'note.txt',
        oldText: 'world',
        newText: 'world!',
        revision: read.revision,
        grant: makeGrant(workspace, 'file.edit'),
      })
      assert.equal(edit.replacedCount, 1)
      assert.ok(edit.revision)
      assert.equal(readFileSync(target, 'utf8'), 'hello\nworld!\n')

      // 3. edit 回写的新凭据链式授权 file.write 覆盖（既有文件覆盖场景）。
      const write = await client.request('file.write', {
        workspaceRoot: workspace,
        path: 'note.txt',
        content: 'hello\nworld!\nmore\n',
        revision: edit.revision,
        grant: makeGrant(workspace, 'file.write'),
      })
      assert.ok(write.revision)
      assert.equal(readFileSync(target, 'utf8'), 'hello\nworld!\nmore\n')

      // 4. 陈旧凭据仍被拒绝：防护没有被放宽，只是凭据链路接通了。
      await assert.rejects(
        client.request('file.write', {
          workspaceRoot: workspace,
          path: 'note.txt',
          content: 'stale\n',
          revision: read.revision, // 首次读取的凭据，文件此后已被 edit+write 改变
          grant: makeGrant(workspace, 'file.write'),
        }),
        /changed since last read/,
      )
    } finally {
      await client.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)

test(
  'file.write honors fresh full-read credentials, denies blind overwrite, exempts new files',
  { skip: BINARY === null },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-writepath-'))
    const target = join(workspace, 'doc.txt')
    writeFileSync(target, 'one\ntwo\n')

    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)

      // 盲写被拒：既有文件不带凭据 → refusing to overwrite（死锁时报错的源头）。
      await assert.rejects(
        client.request('file.write', {
          workspaceRoot: workspace,
          path: 'doc.txt',
          content: 'blind\n',
          grant: makeGrant(workspace, 'file.write'),
        }),
        /refusing to overwrite existing file/,
      )

      // 全新完整读取的凭据直接授权覆盖：不经 edit 链式传递，
      // 这是最典型的"先读 → 整体重写"路径（修复前 read 不发凭据，此路不通）。
      const fresh = await client.request('file.read', {
        workspaceRoot: workspace,
        path: 'doc.txt',
      })
      assert.ok(
        fresh.revision,
        'file.read response must carry nested revision credential',
      )
      const write = await client.request('file.write', {
        workspaceRoot: workspace,
        path: 'doc.txt',
        content: 'one\ntwo!\n',
        revision: fresh.revision,
        grant: makeGrant(workspace, 'file.write'),
      })
      assert.ok(write.revision)
      assert.equal(readFileSync(target, 'utf8'), 'one\ntwo!\n')

      // 新建文件豁免先读约束：无凭据直接写入成功（新建信息经 changedFiles.action 传达）。
      const created = await client.request('file.write', {
        workspaceRoot: workspace,
        path: 'fresh.txt',
        content: 'brand new\n',
        grant: makeGrant(workspace, 'file.write'),
      })
      assert.equal(created.changedFiles[0].action, 'created')
      assert.ok(created.revision)
      assert.equal(
        readFileSync(join(workspace, 'fresh.txt'), 'utf8'),
        'brand new\n',
      )
    } finally {
      await client.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
