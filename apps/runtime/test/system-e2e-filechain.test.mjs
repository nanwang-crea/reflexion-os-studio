import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import { Store } from '../dist/store/index.js'
import { canonicalDigest } from '../dist/agent/permissions/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { createFileReadTool } from '../dist/agent/tools/files-query.js'
import { createFileEditTool } from '../dist/agent/tools/files-edit.js'
import { FileReadState } from '../dist/agent/tools/read-state.js'

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

function makeGrant(workspaceRoot, operation, path) {
  return JSON.stringify({
    version: 2,
    grantId: `grant-${operation}`,
    requestId: 'req-e2e-filechain',
    sessionId: 'sess-e2e-filechain',
    workspaceId: workspaceRoot,
    operation,
    source: 'session-rule',
    subjectDigest: canonicalDigest(operation, [path]),
    sandbox: 'workspace-write',
    sandboxNetwork: false,
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
        grant: makeGrant(workspace, 'file.edit', 'note.txt'),
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
        grant: makeGrant(workspace, 'file.write', 'note.txt'),
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
          grant: makeGrant(workspace, 'file.write', 'note.txt'),
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
  'grant issued for another path cannot authorize this write (approval_subject_mismatch)',
  { skip: BINARY === null },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-digest-'))
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      await assert.rejects(
        client.request('file.write', {
          workspaceRoot: workspace,
          path: 'a.txt',
          content: 'sneak\n',
          // 凭据绑定 b.txt：换目标文件必须被 Rust 复核拒绝。
          grant: makeGrant(workspace, 'file.write', 'b.txt'),
        }),
        (error) =>
          error.code === 'approval_subject_mismatch' ||
          String(error.message).includes('actual resource'),
      )
      assert.equal(existsSync(join(workspace, 'a.txt')), false)
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
          grant: makeGrant(workspace, 'file.write', 'doc.txt'),
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
        grant: makeGrant(workspace, 'file.write', 'doc.txt'),
      })
      assert.ok(write.revision)
      assert.equal(readFileSync(target, 'utf8'), 'one\ntwo!\n')

      // digest 绑定实际资源：批准 doc.txt 的凭据写 fresh.txt 必须被拒
      // （session 授权复用换 target 的兜底硬边界）。
      await assert.rejects(
        client.request('file.write', {
          workspaceRoot: workspace,
          path: 'fresh.txt',
          content: 'wrong target\n',
          grant: makeGrant(workspace, 'file.write', 'doc.txt'),
        }),
        /approval grant does not match the actual resource/,
      )

      // 新建文件豁免先读约束：无凭据直接写入成功（新建信息经 changedFiles.action 传达）。
      const created = await client.request('file.write', {
        workspaceRoot: workspace,
        path: 'fresh.txt',
        content: 'brand new\n',
        grant: makeGrant(workspace, 'file.write', 'fresh.txt'),
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

test(
  'workspace.write_file UI-save flow: runtime registry revision + source:ui against real Rust',
  { skip: BINARY === null },
  async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-uawrite-')))
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-uiws-'))
    writeFileSync(join(workspace, 'note.txt'), 'one\ntwo\n')
    const project = store.projects.create({
      name: 'p',
      folderPath: workspace,
    })
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const ctx = { store, system: client }
      const read = await dispatchCommand(
        'workspace.read_file',
        { projectId: project.id, path: 'note.txt' },
        ctx,
      )
      // 保存只带本次读取快照 token，Runtime 注入其 revision。
      const saved = await dispatchCommand(
        'workspace.write_file',
        {
          projectId: project.id,
          path: 'note.txt',
          content: 'one\ntwo!\n',
          readToken: read.readToken,
        },
        ctx,
      )
      assert.equal(
        readFileSync(join(workspace, 'note.txt'), 'utf8'),
        'one\ntwo!\n',
      )
      // 连续保存：登记随写响应刷新，无需重读即可再存。
      const next = await dispatchCommand(
        'workspace.write_file',
        {
          projectId: project.id,
          path: 'note.txt',
          content: 'one\ntwo?\n',
          readToken: saved.readToken,
        },
        ctx,
      )
      assert.equal(
        readFileSync(join(workspace, 'note.txt'), 'utf8'),
        'one\ntwo?\n',
      )
      // 丢更新保护仍生效：磁盘被外部改动后，陈旧登记凭据必被 Rust 拒绝。
      writeFileSync(join(workspace, 'note.txt'), 'external edit\n')
      // 另一个预览读到新版本，不得给旧编辑器提供新的覆盖凭据。
      await dispatchCommand(
        'workspace.read_file',
        { projectId: project.id, path: 'note.txt' },
        ctx,
      )
      await assert.rejects(
        () =>
          dispatchCommand(
            'workspace.write_file',
            {
              projectId: project.id,
              path: 'note.txt',
              content: 'stomp\n',
              readToken: next.readToken,
            },
            ctx,
          ),
        /changed since last read|fresh full read/,
      )
      assert.equal(
        readFileSync(join(workspace, 'note.txt'), 'utf8'),
        'external edit\n',
      )
    } finally {
      await client.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)

test(
  'atomic file.edit validates numbered ranges and transports bounded operation diagnostics',
  { skip: BINARY === null },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-edit-diagnostics-'))
    const target = join(workspace, 'note.txt')
    writeFileSync(target, 'head\n重复\n重复\nend\n')
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const read = await client.request('file.read', {
        workspaceRoot: workspace,
        path: 'note.txt',
        offset: 1,
        limit: 2,
      })
      const params = {
        workspaceRoot: workspace,
        path: 'note.txt',
        revision: read.revision,
        grant: makeGrant(workspace, 'file.edit', 'note.txt'),
      }
      await assert.rejects(
        client.request('file.edit', {
          ...params,
          edits: [
            { kind: 'replace', oldText: 'head', newText: 'changed' },
            { kind: 'replace', oldText: '重复', newText: 'new' },
          ],
        }),
        (error) => {
          assert.equal(error.code, 'edit_mismatch')
          assert.deepEqual(error.details, {
            operationIndex: 1,
            kind: 'replace',
            reason: 'match_count',
            actualCount: 2,
            expectedCount: 1,
            candidateLines: [2, 3],
            noChangesWritten: true,
          })
          return true
        },
      )
      assert.equal(readFileSync(target, 'utf8'), 'head\n重复\n重复\nend\n')
      for (const edits of [
        [{ kind: 'replace', oldText: 'head', newText: 'changed', typo: true }],
        [
          {
            kind: 'replace',
            oldText: 'head',
            newText: 'changed',
            expectedCount: 0,
          },
        ],
      ]) {
        await assert.rejects(client.request('file.edit', { ...params, edits }))
        assert.equal(readFileSync(target, 'utf8'), 'head\n重复\n重复\nend\n')
      }
      for (const mixed of [
        { expectedCount: 2 },
        { oldText: null },
        { expectedCount: null },
      ]) {
        await assert.rejects(
          client.request('file.edit', {
            ...params,
            edits: [{ kind: 'replace', oldText: 'head', newText: 'changed' }],
            ...mixed,
          }),
          (error) => error.code === 'invalid_request',
        )
      }
      const outcome = await client.request('file.edit', {
        ...params,
        edits: [
          {
            kind: 'replace_range',
            startLine: 2,
            endLine: 3,
            expectedText: `L2: ${read.content.split('\n')[0]}\nL3: ${read.content.split('\n')[1]}`,
            newText: '新块',
          },
        ],
      })
      assert.equal(readFileSync(target, 'utf8'), 'head\n新块\nend\n')
      assert.equal(outcome.structuredPatch[0].before, '重复\n重复')
      await assert.rejects(
        client.request('file.edit', {
          ...params,
          edits: [{ kind: 'replace', oldText: '新块', newText: 'stale' }],
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
  'actual numbered file.read output edits the BOM first line through Runtime tools',
  { skip: BINARY === null },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'reflexion-bom-edit-'))
    const target = join(workspace, 'note.txt')
    writeFileSync(target, '\ufeff首行\r\n第二行\r\n')
    const client = new SystemRuntimeClient(BINARY, [], () => {})
    client.start()
    try {
      await waitReady(client)
      const state = new FileReadState()
      const signal = new AbortController().signal
      const read = await createFileReadTool(client, workspace, state).execute({
        args: { path: 'note.txt', limit: 1 },
        signal,
      })
      assert.equal(read.isError, false)
      const numbered = JSON.parse(read.content).content
      assert.equal(numbered, 'L1: \ufeff首行')
      const edit = await createFileEditTool(client, workspace, state).execute({
        args: {
          path: 'note.txt',
          edits: [
            {
              kind: 'replace_range',
              startLine: 1,
              endLine: 1,
              expectedText: numbered,
              newText: '新首行',
            },
          ],
        },
        signal,
        grant: makeGrant(workspace, 'file.edit', 'note.txt'),
      })
      assert.equal(edit.isError, false, edit.content)
      assert.equal(readFileSync(target, 'utf8'), '\ufeff新首行\r\n第二行\r\n')
    } finally {
      await client.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  },
)
