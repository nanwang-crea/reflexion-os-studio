import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTEXT_TOKEN_BUDGET,
  contextBudgetFor,
} from '../dist/agent/context.js'

test('contextBudgetFor falls back to conservative default when unknown', () => {
  const budget = contextBudgetFor({
    baseUrl: 'http://x',
    apiKey: 'k',
    model: 'm',
  })
  assert.equal(budget, CONTEXT_TOKEN_BUDGET)
})

test('contextBudgetFor scales with model window and reserves output tokens', () => {
  // 128k 窗口：min(24k, 128k*0.75=96k) → 24k（保守上限封顶）。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 128_000,
    }),
    CONTEXT_TOKEN_BUDGET,
  )
  // 16k 窗口：min(24k, 12k) → 12k。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 16_000,
    }),
    12_000,
  )
  // 8k 窗口且 maxTokens=4096：窗口预算 6k − 4k 预留 = 1.9k。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 8_000,
      maxTokens: 4096,
    }),
    1904,
  )
  // 小窗口下限保护：maxTokens 接近窗口时不低于 1024。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 2_000,
      maxTokens: 1900,
    }),
    1024,
  )
})
