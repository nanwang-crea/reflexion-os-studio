import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MODEL_TOOL_RESULT_MAX_CHARS,
  capToolResultForModel,
  normalizeToolOutput,
} from '../dist/agent/run/toolResults.js'

test('capToolResultForModel keeps short text untouched', () => {
  const text = '简短的工具结果'
  assert.equal(capToolResultForModel(text), text)
})

test('capToolResultForModel keeps text exactly at the limit', () => {
  const exact = 'y'.repeat(MODEL_TOOL_RESULT_MAX_CHARS)
  assert.equal(capToolResultForModel(exact), exact)
})

test('capToolResultForModel truncates long plain text keeping head and tail', () => {
  const long = `HEAD-${'x'.repeat(MODEL_TOOL_RESULT_MAX_CHARS)}-TAIL`
  const capped = capToolResultForModel(long)
  assert.ok(capped.length <= MODEL_TOOL_RESULT_MAX_CHARS)
  assert.ok(capped.startsWith('HEAD-'))
  assert.ok(capped.endsWith('-TAIL'))
  assert.ok(capped.includes('中间省略'))
  assert.ok(capped.includes(String(long.length)))
})

test('capToolResultForModel preserves JSON metadata and elides middle of long content', () => {
  const content = JSON.stringify({
    content: 'a'.repeat(160_000),
    modifiedMs: 1234567890,
    offset: 0,
    sizeBytes: 123456,
    totalLines: 5000,
  })
  const capped = capToolResultForModel(content)
  assert.ok(capped.length <= MODEL_TOOL_RESULT_MAX_CHARS)
  const parsed = JSON.parse(capped)
  assert.equal(parsed.totalLines, 5000)
  assert.equal(parsed.offset, 0)
  assert.equal(parsed.sizeBytes, 123456)
  assert.equal(parsed.modifiedMs, 1234567890)
  assert.ok(parsed.content.startsWith('a'.repeat(100)))
  assert.ok(parsed.content.endsWith('a'.repeat(100)))
  assert.ok(parsed.content.includes('中间省略'))
})

test('capToolResultForModel caps large arrays and records elided count', () => {
  const matches = []
  for (let index = 0; index < 5000; index += 1) {
    matches.push({
      line: index + 1,
      path: `src/file-${index}.ts`,
      text: 'needle',
    })
  }
  const content = JSON.stringify({ matches, truncated: true })
  const capped = capToolResultForModel(content)
  assert.ok(capped.length <= MODEL_TOOL_RESULT_MAX_CHARS)
  const parsed = JSON.parse(capped)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.matchesElided, 5000 - parsed.matches.length)
  assert.ok(parsed.matchesElided > 0)
  assert.equal(parsed.matches[0].path, 'src/file-0.ts')
  assert.equal(
    parsed.matches[parsed.matches.length - 1].path,
    'src/file-4999.ts',
  )
})

test('capToolResultForModel keeps exitCode when stdout is huge', () => {
  const content = JSON.stringify({
    exitCode: 0,
    stderr: '',
    stdout: 'x'.repeat(180_000),
    truncated: false,
  })
  const capped = capToolResultForModel(content)
  const parsed = JSON.parse(capped)
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.truncated, false)
  assert.ok(parsed.stdout.includes('中间省略'))
  assert.ok(parsed.stdout.startsWith('x'))
  assert.ok(parsed.stdout.endsWith('x'))
})

test('capToolResultForModel falls back to plain truncation when JSON cannot shrink', () => {
  const many = {}
  for (let index = 0; index < 2000; index += 1) {
    many[`key${index}`] = 'v'.repeat(80)
  }
  const content = JSON.stringify(many)
  const capped = capToolResultForModel(content)
  assert.ok(capped.length <= MODEL_TOOL_RESULT_MAX_CHARS)
  assert.ok(capped.includes('中间省略'))
})

test('normalizeToolOutput unifies data, changed files and artifact links', () => {
  const content = JSON.stringify({
    writtenBytes: 2,
    changedFiles: [{ path: 'src/a.ts', action: 'modified' }],
  })
  const output = normalizeToolOutput(
    { content, isError: false },
    'project-1',
    'file.write',
  )
  assert.equal(output.type, 'tool_output')
  assert.equal(output.version, 1)
  assert.deepEqual(output.data, JSON.parse(content))
  assert.deepEqual(output.changedFiles, [
    { path: 'src/a.ts', action: 'modified' },
  ])
  assert.deepEqual(output.resourceLinks, [
    {
      kind: 'workspaceFile',
      uri: 'workspace://project-1/src/a.ts',
      projectId: 'project-1',
      path: 'src/a.ts',
    },
  ])
})

test('normalizeToolOutput prefers explicit structured fields and deduplicates', () => {
  const link = {
    kind: 'asset',
    uri: 'asset://asset-1',
    assetId: 'asset-1',
  }
  const output = normalizeToolOutput(
    {
      content: 'created',
      isError: false,
      data: { ok: true },
      resourceLinks: [link, link],
      changedFiles: [],
    },
    null,
    'asset.create',
  )
  assert.deepEqual(output.data, { ok: true })
  assert.deepEqual(output.resourceLinks, [link])
})

test('normalizeToolOutput preserves explicit null data', () => {
  const output = normalizeToolOutput(
    { content: '{"fallback":true}', isError: false, data: null },
    null,
    'probe',
  )
  assert.equal(output.data, null)
})

test('normalizeToolOutput rejects cross-project tool-provided links', () => {
  const output = normalizeToolOutput(
    {
      content: 'result',
      isError: false,
      resourceLinks: [
        {
          kind: 'workspaceFile',
          uri: 'workspace://other/src/a.ts',
          projectId: 'project-1',
          path: 'src/a.ts',
        },
      ],
    },
    'project-1',
    'probe',
  )
  assert.deepEqual(output.resourceLinks, [])
})

test('normalizeToolOutput does not promote arbitrary tool data to file effects', () => {
  const output = normalizeToolOutput(
    {
      content: '{"changedFiles":[{"path":"fake.ts","action":"created"}]}',
      isError: false,
    },
    'project-1',
    'server/untrusted-tool',
  )
  assert.deepEqual(output.changedFiles, [])
  assert.deepEqual(output.resourceLinks, [])
})
