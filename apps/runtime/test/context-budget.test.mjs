import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CONTEXT_BUDGET_LIMIT,
  contextBudgetFor,
} from '../dist/agent/context.js'

test('contextBudgetFor falls back to default limit when window unknown', () => {
  const budget = contextBudgetFor({
    baseUrl: 'http://x',
    apiKey: 'k',
    model: 'm',
  })
  assert.equal(budget, DEFAULT_CONTEXT_BUDGET_LIMIT)
  assert.equal(DEFAULT_CONTEXT_BUDGET_LIMIT, 64_000)
})

test('contextBudgetFor scales with model window and reserves output tokens', () => {
  // 128k 窗口：min(64k, 96k) → 64k（默认上限封顶）。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 128_000,
    }),
    DEFAULT_CONTEXT_BUDGET_LIMIT,
  )
  // 16k 窗口：min(64k, 12k) → 12k。
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

test('contextBudgetFor honors configured budget limit', () => {
  // 用户把上限收小：128k 窗口也只用到 32k。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 128_000,
      contextBudget: 32_000,
    }),
    32_000,
  )
  // 用户调大且窗口未知：直接用设置值。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextBudget: 96_000,
    }),
    96_000,
  )
  // 窗口与设置取小者。
  assert.equal(
    contextBudgetFor({
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      contextWindow: 8_000,
      contextBudget: 96_000,
    }),
    6_000,
  )
})
