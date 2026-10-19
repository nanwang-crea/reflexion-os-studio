import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileEditTool } from '../../dist/agent/tools/files-edit.js'
import { createFileEditBatchTool } from '../../dist/agent/tools/file-writing/batch.js'
import { FileReadState } from '../../dist/agent/tools/read-state.js'
import {
  executeFileEditBatch,
  toolCallCost,
} from '../../dist/agent/run/editing/batch.js'
import { FILE_WRITE_POLICY } from '../../dist/agent/run/tool-policies.js'
import { fixture, request } from './fixture.mjs'

function setup(t, preset) {
  const f = fixture(t, preset)
  const calls = []
  const readState = new FileReadState()
  const revision = { modifiedMs: 1, sizeBytes: 1, sha256: 'a'.repeat(64) }
  for (const path of ['a.ts', 'b.ts'])
    readState.record(path, { revision, complete: true })
  const system = {
    request: async (method, params) => {
      calls.push({ method, ...params })
      if (params.path === 'b.ts')
        throw new Error('file changed since last read')
      return { path: params.path, before: 'a', after: 'b', revision }
    },
  }
  f.registry.register({
    ...createFileEditTool(system, f.workspaceRoot, readState),
    execution: FILE_WRITE_POLICY,
  })
  f.registry.register(createFileEditBatchTool())
  return { ...f, calls }
}
const edit = (path) => ({
  path,
  edits: [{ kind: 'replace', oldText: 'a', newText: 'b' }],
})

test('batch retains exact per-file grants and canonical partial results, without fake model declarations', async (t) => {
  const f = setup(t)
  const result = await executeFileEditBatch(
    f,
    {},
    request('batch', 'file.edit_batch', {
      files: [edit('a.ts'), edit('b.ts')],
    }),
    new AbortController().signal,
  )
  assert.equal(result.isError, true)
  assert.equal(
    JSON.parse(result.content).results[0].summary,
    '编辑已完成，不要重放',
  )
  assert.doesNotMatch(result.content, /sha256/)
  assert.equal(result.replayUnsafe, true)
  assert.equal(result.data.atomicAcrossFiles, false)
  assert.deepEqual(
    result.data.results.map((entry) => entry.status),
    ['completed', 'failed'],
  )
  assert.match(result.data.results[1].output.content, /revision/)
  assert.equal(f.calls.length, 2)
  for (const call of f.calls) {
    assert.equal(call.method, 'file.edit')
    const grant = JSON.parse(call.grant)
    assert.equal(grant.operation, 'file.edit')
    assert.equal(typeof grant.subjectDigest, 'string')
    assert.deepEqual(call.revision.sha256, 'a'.repeat(64))
  }
  assert.notEqual(
    JSON.parse(f.calls[0].grant).subjectDigest,
    JSON.parse(f.calls[1].grant).subjectDigest,
  )
  const rows = f.store.toolCalls.listByRun(f.run.id)
  assert.equal(
    rows.filter((row) => row.messageId === f.state.lastAssistantMessageId)
      .length,
    1,
  )
  assert.equal(
    rows.filter((row) => row.toolName === 'file.edit' && row.output).length,
    2,
  )
})

test('duplicate or invalid paths reject the whole batch before writes', async (t) => {
  const f = setup(t)
  for (const paths of [
    ['a.ts', './a.ts'],
    ['a.ts', '../outside'],
  ]) {
    const result = await executeFileEditBatch(
      f,
      {},
      request('batch', 'file.edit_batch', { files: paths.map(edit) }),
      new AbortController().signal,
    )
    assert.equal(result.isError, true)
  }
  assert.equal(f.calls.length, 0)
})

test('plan mode cannot use batch to bypass per-file permission checks', async (t) => {
  const f = setup(t)
  const { PermissionGate } =
    await import('../../dist/agent/permissions/index.js')
  f.gate = new PermissionGate({
    preset: 'workspace-full',
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => true,
    executionMode: () => 'plan',
  })
  const result = await executeFileEditBatch(
    f,
    {},
    request('batch', 'file.edit_batch', { files: [edit('a.ts')] }),
    new AbortController().signal,
  )
  assert.equal(result.isError, true)
  assert.equal(f.calls.length, 0)
})

test('multi-file budget counts orchestration and every concrete edit', () => {
  assert.equal(
    toolCallCost(
      request('b', 'file.edit_batch', { files: [edit('a.ts'), edit('b.ts')] }),
    ),
    3,
  )
  assert.equal(toolCallCost(request('b', 'file.edit_batch', {})), 1)
})

test('batch progress is durable before remaining edits finish and survives cancellation', async (t) => {
  const { deferred, tick } = await import('./fixture.mjs')
  const f = fixture(t),
    first = deferred(),
    controller = new AbortController()
  f.registry.register(createFileEditBatchTool())
  f.registry.register({
    name: 'file.edit',
    description: 'edit',
    parameters: { type: 'object' },
    execution: FILE_WRITE_POLICY,
    execute: async ({ args, signal }) => {
      if (args.path === 'a.ts') {
        first.resolve()
        return {
          content: 'edited a',
          isError: false,
          changedFiles: [{ path: 'a.ts', action: 'modified' }],
        }
      }
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      )
      return { content: '', isError: false }
    },
  })
  const pending = executeFileEditBatch(
    f,
    {},
    request('batch', 'file.edit_batch', {
      files: [edit('a.ts'), edit('b.ts')],
    }),
    controller.signal,
  )
  await first.promise
  await tick()
  const before = f.store.toolCalls
    .listByRun(f.run.id)
    .find((row) => row.toolName === 'file.edit_batch')
  assert.equal(before.status, 'running')
  assert.equal(before.output.data.results[0].status, 'completed')
  assert.equal(before.output.data.results[1].status, 'not_executed')
  controller.abort()
  await assert.rejects(pending)
  const after = f.store.toolCalls.get(before.id)
  assert.equal(after.status, 'cancelled')
  assert.equal(after.output.data.results[0].status, 'completed')
})

test('Run finalization preserves canonical progress when cancelling an unfinished batch', async (t) => {
  const { RunFinalizer } = await import('../../dist/agent/run/run-finalizer.js')
  const f = fixture(t)
  const row = f.store.toolCalls.create({
    runId: f.run.id,
    messageId: f.state.lastAssistantMessageId,
    toolName: 'file.edit_batch',
    args: {},
    status: 'pending',
  })
  const output = {
    type: 'tool_output',
    version: 1,
    content: 'successful child retained',
    data: { checkpoint: true },
    changedFiles: [],
    resourceLinks: [],
    provenance: null,
  }
  f.store.toolCalls.recordProgressOutput(row.id, output)
  f.state.toolCallRowIds.add(row.id)
  new RunFinalizer(f.store).finalize(f, {
    status: 'cancelled',
    errorCode: null,
    errorMessage: null,
    pendingMessage: null,
  })
  assert.deepEqual(f.store.toolCalls.get(row.id).output, output)
})
