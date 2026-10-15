import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileWriteStreamTool } from '../dist/agent/tools/file-writing/tool.js'
import { restoreFileWrites } from '../dist/agent/tools/file-writing/state.js'
import { FileReadState } from '../dist/agent/tools/read-state.js'
import { normalizeToolOutput } from '../dist/agent/run/toolResults.js'
import { withTaskContext } from '../dist/agent/context/task-context.js'
import { compactInRun } from '../dist/agent/context/context.js'
import { Store } from '../dist/store/index.js'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import { canonicalDigest } from '../dist/agent/permissions/index.js'

const context = (args, grant = 'grant') => ({
  args,
  grant,
  signal: new AbortController().signal,
})
function fakeSystem() {
  const calls = []
  let offset = 0
  return {
    calls,
    request: async (_, params) => {
      calls.push(params)
      if (params.action === 'begin') {
        offset = 0
        return { uploadId: 'b'.repeat(64), nextOffset: 0 }
      }
      if (params.action === 'append') {
        assert.equal(params.offset, offset)
        offset += Buffer.byteLength(params.content)
        return { nextOffset: offset }
      }
      return {
        writtenBytes: offset,
        changedFiles: [{ path: params.path, action: 'created' }],
      }
    },
  }
}

test('generic chunks are idempotent, ordered, bounded and hide protocol handles', async () => {
  const system = fakeSystem()
  const tool = createFileWriteStreamTool(system, '/ws', new FileReadState())
  const call = (action, extra = {}) =>
    tool.execute(context({ action, path: 'data.json', ...extra }))
  const begin = await call('begin')
  assert.doesNotMatch(begin.content, /uploadId|nextOffset/)
  await call('begin')
  assert.equal(system.calls.length, 1)
  const first = { chunkIndex: 0, title: 'JSON opening', content: '["你好",\n' }
  assert.equal((await call('append', first)).isError, false)
  await call('append', { ...first, title: 'different progress label' })
  assert.equal(system.calls.length, 2)
  for (const args of [
    { ...first, content: 'different' },
    { chunkIndex: 2, content: 'out of order' },
    { chunkIndex: 1, content: '中'.repeat(180_000) },
    { chunkIndex: -1, content: '' },
    { chunkIndex: 1.5, content: '' },
    { chunkIndex: 1 },
    { uploadId: 'c'.repeat(64), offset: 0, content: 'legacy' },
  ])
    assert.equal((await call('append', args)).isError, true)
  assert.equal(system.calls.length, 2)
  assert.equal(
    (await call('append', { chunkIndex: 1, content: '"world"]' })).isError,
    false,
  )
  const status = JSON.parse((await call('status')).content)
  assert.equal(status.nextChunkIndex, 2)
  assert.equal(
    status.acceptedBytes,
    Buffer.byteLength(first.content + '"world"]'),
  )
  const committed = await call('commit')
  assert.equal(
    normalizeToolOutput(committed, null, 'file.write_stream').changedFiles
      .length,
    1,
  )
  await call('commit')
  await call('begin')
  assert.equal(system.calls.length, 4)
  assert.equal(
    (await call('append', { chunkIndex: 2, content: 'late' })).isError,
    true,
  )
  await call('abort') // resetting a committed upload never deletes its target
  assert.equal(system.calls.length, 4)
  await call('begin')
  await call('abort')
  await call('abort')
  assert.equal(system.calls.length, 6)
  assert.equal(JSON.parse((await call('status')).content).phase, 'aborted')
})

test('failed append preserves the same chunk index, offset and hash for retry', async () => {
  const system = fakeSystem()
  const request = system.request
  let fail = true
  system.request = async (method, params) => {
    if (params.action === 'append' && fail) {
      fail = false
      throw new Error('temporary failure')
    }
    return request(method, params)
  }
  const tool = createFileWriteStreamTool(system, '/ws', new FileReadState())
  await tool.execute(context({ action: 'begin', path: 'a.ts' }))
  const args = {
    action: 'append',
    path: 'a.ts',
    chunkIndex: 0,
    content: 'export const n = 1\n',
  }
  assert.equal((await tool.execute(context(args))).isError, true)
  assert.equal(
    JSON.parse(
      (await tool.execute(context({ action: 'status', path: 'a.ts' }))).content,
    ).nextChunkIndex,
    0,
  )
  assert.equal((await tool.execute(context(args))).isError, false)
  assert.equal(system.calls[1].offset, 0)
})

function fixture(root, workspace) {
  const store = new Store(root)
  const project = store.projects.create({ name: 'p', folderPath: workspace })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: 'Create a large data file',
    status: 'completed',
  })
  const assistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'completed',
  })
  function persist(args, result) {
    const call = store.toolCalls.create({
      runId: run.id,
      messageId: assistant.id,
      toolName: 'file.write_stream',
      args,
    })
    store.toolCalls.finalize(
      call.id,
      result.isError ? 'failed' : 'completed',
      normalizeToolOutput(result, project.id, 'file.write_stream'),
    )
  }
  return { store, session, persist }
}

test('canonical checkpoints survive reopen, session isolation and context compaction', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-file-write-state-'))
  let { store, session, persist } = fixture(root, '/ws')
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const system = fakeSystem()
  let tool = createFileWriteStreamTool(system, '/ws', new FileReadState())
  for (const args of [
    { action: 'begin', path: 'data.csv' },
    {
      action: 'append',
      path: 'data.csv',
      chunkIndex: 0,
      content: 'name,value\n甲,1\n',
    },
  ])
    persist(args, await tool.execute(context(args)))
  const sessionId = session.id
  store.close()
  store = new Store(root)
  const states = restoreFileWrites(store, sessionId, '/ws')
  assert.equal(states.get('data.csv').chunks.length, 1)
  assert.equal(restoreFileWrites(store, sessionId, '/other').size, 0)
  assert.equal(
    restoreFileWrites(store, store.sessions.create(null).id, '/ws').size,
    0,
  )
  tool = createFileWriteStreamTool(system, '/ws', new FileReadState(), states)
  const count = system.calls.length
  const status = await tool.execute(
    context({ action: 'begin', path: './data.csv' }),
  )
  assert.equal(system.calls.length, count)
  assert.equal(JSON.parse(status.content).nextChunkIndex, 1)
  const prepared = withTaskContext(store, sessionId, [
    { role: 'system', content: 'system' },
    ...Array.from({ length: 12 }, () => ({
      role: 'user',
      content: 'long history '.repeat(200),
    })),
  ])
  const bounded = compactInRun(prepared, { contextBudget: 500 })
  const task = bounded.find((message) => message.control === 'task_context')
  assert.ok(task)
  assert.match(task.content, /nextChunkIndex":1/)
  assert.doesNotMatch(task.content, /uploadId|name,value/)
  const preserved = {
    ...task,
    content:
      'task\n' +
      JSON.stringify({ goal: 'original goal', activeFileWrites: [] }),
  }
  const refreshed = withTaskContext(store, sessionId, [preserved])[0]
  assert.match(refreshed.content, /original goal/)
  assert.match(refreshed.content, /nextChunkIndex":1/)
  assert.equal(
    (
      await tool.execute(
        context({
          action: 'append',
          path: 'data.csv',
          chunkIndex: 1,
          content: '乙,2\n',
        }),
      )
    ).isError,
    false,
  )
})

const binary = resolveSystemRuntimeBinary()
test(
  'real Rust staging assembles generic UTF-8 files and resumes saved progress',
  { skip: binary === null },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'reflexion-file-write-e2e-'))
    const client = new SystemRuntimeClient(binary, [], () => {})
    t.after(async () => {
      await client.shutdown()
      rmSync(root, { recursive: true, force: true })
    })
    client.start()
    const deadline = Date.now() + 10_000
    while (!client.available && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(client.available, true)
    for (const [path, chunks] of [
      ['source.ts', ['export const greeting = ', '"你好 🌍"\n']],
      [
        'data.json',
        [
          '[\n',
          ...Array.from(
            { length: 8 },
            (_, i) =>
              JSON.stringify('中'.repeat(100_000)) + (i < 7 ? ',\n' : '\n'),
          ),
          ']',
        ],
      ],
    ]) {
      const states = new Map()
      const readState = new FileReadState()
      let tool = createFileWriteStreamTool(client, root, readState, states)
      const grant = JSON.stringify({
        version: 2,
        grantId: 'g',
        requestId: 'r',
        sessionId: 's',
        workspaceId: root,
        operation: 'file.write_stream',
        source: 'session-rule',
        subjectDigest: canonicalDigest('file.write_stream', [path]),
        sandbox: 'workspace-write',
        sandboxNetwork: false,
        expiresAt: Date.now() + 60_000,
      })
      const invoke = (args) => tool.execute(context({ path, ...args }, grant))
      assert.equal((await invoke({ action: 'begin' })).isError, false)
      for (const [chunkIndex, content] of chunks.entries()) {
        const args = { action: 'append', chunkIndex, content }
        assert.equal((await invoke(args)).isError, false)
        // Recreate the tool from a serialized checkpoint, without any model history.
        tool = createFileWriteStreamTool(
          client,
          root,
          readState,
          new Map(JSON.parse(JSON.stringify([...states]))),
        )
        assert.equal((await invoke(args)).isError, false)
        // Keep the latest checkpoint for the next recreation.
        const current = (await invoke({ action: 'status' })).data
          .fileWriteCheckpoint
        states.set(path, current)
        assert.equal(existsSync(join(root, path)), false)
      }
      const result = await invoke({ action: 'commit' })
      assert.equal(result.isError, false, result.content)
      assert.equal(readFileSync(join(root, path), 'utf8'), chunks.join(''))
      assert.ok(readState.entry(path).revision.sha256)
      if (path.endsWith('.json'))
        assert.equal(
          JSON.parse(readFileSync(join(root, path), 'utf8')).length,
          8,
        )
    }
  },
)
