import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MODEL_TOOL_RESULT_MAX_CHARS,
  capToolResultForModel,
} from '../dist/agent/toolResults.js'

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
    content: 'a'.repeat(60_000),
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
  for (let index = 0; index < 500; index += 1) {
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
  assert.equal(parsed.matchesElided, 500 - parsed.matches.length)
  assert.ok(parsed.matchesElided > 0)
  assert.equal(parsed.matches[0].path, 'src/file-0.ts')
  assert.equal(
    parsed.matches[parsed.matches.length - 1].path,
    'src/file-499.ts',
  )
})

test('capToolResultForModel keeps exitCode when stdout is huge', () => {
  const content = JSON.stringify({
    exitCode: 0,
    stderr: '',
    stdout: 'x'.repeat(80_000),
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
  for (let index = 0; index < 400; index += 1) {
    many[`key${index}`] = 'v'.repeat(80)
  }
  const content = JSON.stringify(many)
  const capped = capToolResultForModel(content)
  assert.ok(capped.length <= MODEL_TOOL_RESULT_MAX_CHARS)
  assert.ok(capped.includes('中间省略'))
})
