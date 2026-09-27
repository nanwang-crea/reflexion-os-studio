import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFileEditTool,
  createFileWriteStreamTool,
  createFileWriteTool,
} from '../dist/agent/tools/files-mutate.js'
import { FileReadState } from '../dist/agent/tools/read-state.js'
import { callSystem } from '../dist/agent/tools/shared.js'

const revision = { modifiedMs: 1, sizeBytes: 3, sha256: 'a'.repeat(64) }
const context = (args) => ({
  args,
  signal: new AbortController().signal,
  grant: 'grant',
})

test('file.edit forwards batches and preserves legacy empty replacements', async () => {
  const calls = []
  const system = {
    request: async (method, params) => {
      calls.push({ method, params })
      return {
        replacedCount: 1,
        sizeBytes: 3,
        revision,
        changedFiles: [],
        structuredPatch: [],
      }
    },
  }
  const state = new FileReadState()
  state.record('a.txt', { revision, complete: false })
  const tool = createFileEditTool(system, '/ws', state)
  await tool.execute(
    context({
      path: 'a.txt',
      edits: [
        { kind: 'insert_before', anchor: 'a', content: '' },
        {
          kind: 'replace_range',
          startLine: 2,
          endLine: 2,
          expectedText: 'b',
          newText: '',
        },
      ],
    }),
  )
  assert.equal(calls[0].method, 'file.edit')
  assert.equal(calls[0].params.edits.length, 2)
  assert.equal(calls[0].params.edits[1].newText, '')
  await tool.execute(context({ path: 'a.txt', oldText: 'a', newText: '' }))
  assert.equal(calls[1].params.newText, '')
})

test('file.write accepts empty new files and rejects incomplete overwrite coverage', async () => {
  let called = false
  const system = {
    request: async () => {
      called = true
      return { writtenBytes: 0, revision, changedFiles: [] }
    },
  }
  const created = await createFileWriteTool(
    system,
    '/ws',
    new FileReadState(),
  ).execute(context({ path: 'empty.txt', content: '' }))
  assert.equal(created.isError, false)
  assert.equal(called, true)

  const state = new FileReadState()
  state.record('a.txt', { revision, complete: false })
  const overwrite = await createFileWriteTool(system, '/ws', state).execute(
    context({ path: './a.txt', content: '' }),
  )
  assert.equal(overwrite.isError, true)
})

test('stale writes use a stable conflict result and instruct a fresh merge', async () => {
  const system = {
    request: async () => {
      throw new Error('file changed since last read: a.txt')
    },
  }
  const result = await callSystem(
    system,
    'file.edit',
    {},
    new AbortController().signal,
  )
  assert.equal(result.isError, true)
  assert.equal(result.code, 'file_revision_conflict')
  assert.match(result.content, /重新 file\.read/)
  assert.match(result.content, /禁止原样重试/)
})

test('file.write_stream injects revision and hashes each UTF-8 chunk', async () => {
  const calls = []
  const system = {
    request: async (method, params) => {
      calls.push({ method, params })
      if (params.action === 'begin')
        return { uploadId: 'b'.repeat(64), nextOffset: 0 }
      if (params.action === 'append')
        return {
          acceptedBytes: 6,
          nextOffset: 6,
          chunkSha256: params.chunkSha256,
        }
      return { writtenBytes: 6, revision, changedFiles: [] }
    },
  }
  const state = new FileReadState()
  state.record('large.txt', { revision, complete: false })
  const tool = createFileWriteStreamTool(system, '/ws', state)
  await tool.execute(context({ action: 'begin', path: 'large.txt' }))
  await tool.execute(
    context({
      action: 'append',
      path: 'large.txt',
      uploadId: 'b'.repeat(64),
      offset: 0,
      content: '你好',
    }),
  )
  await tool.execute(
    context({
      action: 'commit',
      path: 'large.txt',
      uploadId: 'b'.repeat(64),
      expectedSize: 6,
    }),
  )
  assert.deepEqual(
    calls.map((call) => call.method),
    ['file.write_stream', 'file.write_stream', 'file.write_stream'],
  )
  assert.deepEqual(calls[0].params.revision, revision)
  assert.equal(
    calls[1].params.chunkSha256,
    '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e',
  )
  assert.deepEqual(state.entry('large.txt').revision, revision)
})
