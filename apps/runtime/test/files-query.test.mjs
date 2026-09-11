import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFileGlobTool,
  createFileListTool,
  createFileReadTool,
} from '../dist/agent/tools/files-query.js'
import { FileReadState } from '../dist/agent/tools/read-state.js'

function fakeSystem(handler) {
  return {
    available: true,
    request: (method, params) => handler(method, params),
  }
}

function run(tool, args) {
  return tool.execute({ args, signal: new AbortController().signal })
}

test('file.list exposes offset/limit and continuation guidance in description', () => {
  const tool = createFileListTool(
    fakeSystem(() => ({})),
    '/ws',
  )
  assert.equal(tool.name, 'file.list')
  assert.ok(tool.description.includes('offset'))
  assert.ok(tool.description.includes('truncated'))
  assert.ok(tool.description.includes('nextOffset'))
  assert.ok(tool.description.includes('recursive'))
  assert.ok(tool.description.includes('同一 path'))
  const props = tool.parameters.properties
  assert.equal(props.offset.type, 'number')
  assert.equal(props.limit.type, 'number')
})

test('file.list forwards offset/limit and normalizes non-negative integers', async () => {
  const calls = []
  const system = fakeSystem(async (_method, params) => {
    calls.push(params)
    return { entries: [], returnedCount: 0, truncated: false }
  })
  const tool = createFileListTool(system, '/ws')

  await run(tool, { path: 'src', recursive: true, offset: 2, limit: 10 })
  assert.deepEqual(calls[0], {
    workspaceRoot: '/ws',
    path: 'src',
    recursive: true,
    offset: 2,
    limit: 10,
  })

  await run(tool, { path: 'src', offset: -5, limit: 0 })
  assert.deepEqual(calls[1], {
    workspaceRoot: '/ws',
    path: 'src',
    offset: 0,
    limit: 1,
  })

  await run(tool, { path: 'src' })
  assert.deepEqual(calls[2], { workspaceRoot: '/ws', path: 'src' })
})

test('file.list truncated result keeps continuation metadata intact', async () => {
  const system = fakeSystem(async () => ({
    entries: [{ path: 'a.ts', kind: 'file', sizeBytes: 1 }],
    returnedCount: 1,
    truncated: true,
    nextOffset: 1,
  }))
  const tool = createFileListTool(system, '/ws')
  const result = await run(tool, { path: '.', offset: 0, limit: 1 })

  assert.equal(result.isError, false)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.nextOffset, 1)
  assert.equal(parsed.returnedCount, 1)
  assert.equal(parsed.entries.length, 1)
  // 续读元数据由通用截断层结构性保留（只收缩超长字符串/大数组字段），
  // 不再依赖键的序列化顺序。
})

test('file.list complete result stays valid JSON with truncation metadata', async () => {
  const system = fakeSystem(async () => ({
    entries: [
      { path: 'a.ts', kind: 'file', sizeBytes: 1 },
      { path: 'b.ts', kind: 'file', sizeBytes: 2 },
    ],
    returnedCount: 2,
    truncated: false,
  }))
  const tool = createFileListTool(system, '/ws')
  const result = await run(tool, { path: '.' })

  assert.equal(result.isError, false)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.truncated, false)
  assert.equal(parsed.nextOffset, undefined)
  assert.equal(parsed.returnedCount, 2)
})

test('file.list collapses system errors into a failed tool result', async () => {
  const system = fakeSystem(async () => {
    throw new Error('boom')
  })
  const tool = createFileListTool(system, '/ws')
  const result = await run(tool, { path: '.' })

  assert.equal(result.isError, true)
  assert.equal(result.code, 'tool_error')
  assert.ok(result.content.includes('boom'))
})

test('file.read numbers lines with absolute line numbers from offset', async () => {
  const system = fakeSystem(async () => ({
    content: 'alpha\nbeta\ngamma',
    sizeBytes: 17,
    totalLines: 5,
    offset: 2,
    modifiedMs: 42,
  }))
  const tool = createFileReadTool(system, '/ws', new FileReadState())
  const result = await run(tool, { path: 'a.txt', offset: 2 })

  assert.equal(result.isError, false)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.content, 'L3: alpha\nL4: beta\nL5: gamma')
  assert.equal(parsed.offset, 2)
  assert.equal(parsed.totalLines, 5)
  assert.equal(parsed.returnedLines, 3)
  assert.equal(parsed.contentTruncated, false)
  assert.equal(parsed.nextOffset, undefined)
  assert.equal(parsed.modifiedMs, 42)
})

test('file.read paginates by char budget with explicit nextOffset', async () => {
  const lines = []
  for (let index = 0; index < 2000; index += 1) {
    lines.push(`line-${index}`)
  }
  const system = fakeSystem(async () => ({
    content: lines.join('\n'),
    sizeBytes: 90_000,
    totalLines: 2000,
    offset: 0,
    modifiedMs: 7,
  }))
  const tool = createFileReadTool(system, '/ws', new FileReadState())
  const result = await run(tool, { path: 'big.txt' })

  assert.equal(result.isError, false)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.contentTruncated, true)
  assert.ok(parsed.nextOffset > 0 && parsed.nextOffset < 2000)
  assert.ok(parsed.content.length <= 16_000)
  assert.ok(parsed.content.startsWith('L1: line-0\n'))
  assert.ok(parsed.content.includes('本窗口已按行预算截断'))
  assert.ok(parsed.hint.includes('nextOffset'))
  assert.equal(parsed.totalLines, 2000)
})

test('file.read forwards system errors untouched and records read state on success', async () => {
  const failing = fakeSystem(async () => {
    throw new Error('not utf-8')
  })
  const tool = createFileReadTool(failing, '/ws', new FileReadState())
  const failed = await run(tool, { path: 'x.bin' })
  assert.equal(failed.isError, true)
  assert.equal(failed.code, 'tool_error')

  const readState = new FileReadState()
  const working = fakeSystem(async () => ({
    content: 'one',
    sizeBytes: 3,
    totalLines: 1,
    offset: 0,
    modifiedMs: 99,
    // W2：完整读取凭据为 revision 三字段（mtime+size+sha256）。
    revision: { modifiedMs: 99, sizeBytes: 3, sha256: 'a'.repeat(64) },
  }))
  const okTool = createFileReadTool(working, '/ws', readState)
  const ok = await run(okTool, { path: 'a.txt' })
  assert.equal(ok.isError, false)
  assert.equal(readState.token('a.txt'), 99)
})

test('file.glob forwards offset and exposes continuation in description', async () => {
  const calls = []
  const system = fakeSystem(async (_method, params) => {
    calls.push(params)
    return { matches: [], truncated: false }
  })
  const tool = createFileGlobTool(system, '/ws')

  await run(tool, { pattern: '**/*.ts', offset: 5, limit: 10 })
  assert.deepEqual(calls[0], {
    workspaceRoot: '/ws',
    pattern: '**/*.ts',
    offset: 5,
    limit: 10,
  })

  await run(tool, { pattern: '**/*.ts', offset: -3 })
  assert.deepEqual(calls[1], {
    workspaceRoot: '/ws',
    pattern: '**/*.ts',
    offset: 0,
  })

  assert.ok(tool.description.includes('nextOffset'))
  assert.equal(tool.parameters.properties.offset.type, 'number')
})
