import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileListTool } from '../dist/agent/tools/files-query.js'

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
