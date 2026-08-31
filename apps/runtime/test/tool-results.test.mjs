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

test('capToolResultForModel truncates long text with explicit notice', () => {
  const long = 'x'.repeat(MODEL_TOOL_RESULT_MAX_CHARS + 5000)
  const capped = capToolResultForModel(long)
  // 主体严格截断到上限，剩余部分只承载截断提示。
  assert.equal(
    capped.slice(0, MODEL_TOOL_RESULT_MAX_CHARS),
    long.slice(0, MODEL_TOOL_RESULT_MAX_CHARS),
  )
  assert.ok(!capped.slice(MODEL_TOOL_RESULT_MAX_CHARS).includes('x'))
  assert.ok(capped.includes('结果过长已截断'))
  assert.ok(capped.includes(String(long.length)))
})

test('capToolResultForModel keeps text exactly at the limit', () => {
  const exact = 'y'.repeat(MODEL_TOOL_RESULT_MAX_CHARS)
  assert.equal(capToolResultForModel(exact), exact)
})
