import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkAbsoluteUrl,
  contractRangeHint,
  formatFieldFeedbacks,
  summarizeZodIssuesForLog,
  validateCommandParams,
} from '../dist/index.js'

const VALID_PROVIDER = {
  requestId: 'r1',
  name: 'Demo',
  baseUrl: 'https://api.example.com/v1',
  models: ['gpt-4'],
  secret: 'sk-xx',
}

test('provider.configure：缺协议 baseUrl 报出字段路径与中文说明', () => {
  const feeds = validateCommandParams('provider.configure', {
    ...VALID_PROVIDER,
    baseUrl: 'api.openai.com/v1',
  })
  assert.ok(feeds)
  assert.equal(feeds[0].path, 'baseUrl')
  assert.match(feeds[0].message, /Base URL/)
  assert.match(feeds[0].message, /https:\/\//)
})

test('provider.configure：temperature 越界显示具体边界与中文标签', () => {
  const feeds = validateCommandParams('provider.configure', {
    ...VALID_PROVIDER,
    temperature: 2.5,
  })
  assert.ok(feeds)
  assert.equal(feeds[0].path, 'temperature')
  assert.match(feeds[0].message, /Temperature/)
  // max 是 inclusive：应显示 ≤2 而不是 <2
  assert.match(feeds[0].message, /≤2/)
})

test('provider.configure：模型列表空串定位到具体下标', () => {
  const feeds = validateCommandParams('provider.configure', {
    ...VALID_PROVIDER,
    models: ['glm-4.6', ''],
  })
  assert.ok(feeds)
  assert.equal(feeds[0].path, 'models[1]')
  // 数组下标应落到父字段"模型列表"而不是数字"1"。
  assert.match(feeds[0].message, /模型列表第 2 项/)
})

test('provider.configure：空字符串 secretRef 报 API Key 引用不能为空', () => {
  const feeds = validateCommandParams('provider.configure', {
    ...VALID_PROVIDER,
    id: 'p1',
    secretRef: '',
    secret: undefined,
  })
  assert.ok(feeds)
  assert.equal(feeds[0].path, 'secretRef')
  assert.match(feeds[0].message, /API Key 引用/)
})

test('provider.configure：safeint ceiling 不作为业务边界暴露', () => {
  const feeds = validateCommandParams('provider.configure', {
    ...VALID_PROVIDER,
    maxTokens: 1e21,
  })
  assert.ok(feeds)
  // 不应把 9007199254740991 直接吐给用户，那既不是业务约束也难读。
  assert.doesNotMatch(feeds[0].message, /9007199254740991/)
  assert.match(feeds[0].message, /超出安全整数范围/)
})

test('provider.configure：合法参数通过预检返回 null', () => {
  assert.equal(
    validateCommandParams('provider.configure', VALID_PROVIDER),
    null,
  )
})

test('agent_settings.update：越界字段以中文标签 + 具体范围呈现', () => {
  const feeds = validateCommandParams('agent_settings.update', {
    requestId: 'r1',
    settings: {
      maxTurns: 999,
      reflectionThreshold: null,
      requestRetries: null,
      requestTimeoutSec: null,
      maxRunTimeoutSec: null,
      maxRunTotalTokens: null,
      maxToolCalls: null,
      maxContinuationTurns: null,
      maxDepth: null,
      maxChildRuns: null,
      maxParallelChildren: null,
      maxChildTimeoutSec: null,
      maxChildTotalTokens: null,
      enableChildRuns: false,
    },
  })
  assert.ok(feeds)
  assert.equal(feeds[0].path, 'settings.maxTurns')
  assert.match(feeds[0].message, /最大轮次/)
  assert.match(feeds[0].message, /≤256/)
})

test('agent_settings.update：多个越界字段一次全列出（不吞后续原因）', () => {
  const feeds = validateCommandParams('agent_settings.update', {
    requestId: 'r1',
    settings: {
      maxTurns: 0,
      reflectionThreshold: 100,
      requestRetries: null,
      requestTimeoutSec: 5,
      maxRunTimeoutSec: null,
      maxRunTotalTokens: null,
      maxToolCalls: null,
      maxContinuationTurns: null,
      maxDepth: null,
      maxChildRuns: null,
      maxParallelChildren: null,
      maxChildTimeoutSec: null,
      maxChildTotalTokens: null,
      enableChildRuns: false,
    },
  })
  assert.ok(feeds)
  const paths = feeds.map((item) => item.path)
  assert.ok(paths.includes('settings.maxTurns'))
  assert.ok(paths.includes('settings.reflectionThreshold'))
  assert.ok(paths.includes('settings.requestTimeoutSec'))
})

test('formatFieldFeedbacks：>3 条压缩为"另有 N 处"', () => {
  const line = formatFieldFeedbacks([
    { path: 'a', message: 'A 不对' },
    { path: 'b', message: 'B 不对' },
    { path: 'c', message: 'C 不对' },
    { path: 'd', message: 'D 不对' },
  ])
  assert.match(line, /^a：A 不对；b：B 不对；c：C 不对；另有 1 处/)
})

test('summarizeZodIssuesForLog：只输出 path + 中文说明，不含用户输入', () => {
  const lines = summarizeZodIssuesForLog([
    {
      path: ['baseUrl'],
      code: 'invalid_format',
      format: 'url',
      message: 'Invalid URL',
    },
  ])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^baseUrl: /)
  // 绝不能把用户提交的原始值写进日志。
  assert.ok(!/api\.openai\.com/.test(lines[0]))
})

test('contractRangeHint：正整数（safeint ceiling 已过滤）显示具体下界', () => {
  assert.equal(
    contractRangeHint('provider.configure', 'maxTokens'),
    '应为 ≥1 的整数',
  )
  assert.equal(
    contractRangeHint('agent_settings.update', 'settings.maxTurns'),
    '应为 1–256 的整数',
  )
  assert.equal(
    contractRangeHint('agent_settings.update', 'settings.requestTimeoutSec'),
    '应为 10–600 的整数',
  )
  assert.equal(
    contractRangeHint('provider.configure', 'temperature'),
    '应为 0–2 的数字',
  )
  assert.equal(
    contractRangeHint('provider.configure', 'baseUrl'),
    '需是带协议的完整 URL，如 https://api.example.com/v1',
  )
})

test('checkAbsoluteUrl：常见错误各有独立中文分支', () => {
  assert.equal(checkAbsoluteUrl(''), '地址不能为空')
  assert.match(checkAbsoluteUrl('api.openai.com/v1'), /带协议的完整 URL/)
  assert.match(checkAbsoluteUrl('ftp://x.com'), /协议只支持 http 或 https/)
  // 整行粘贴 Key + URL 时（含空格），应指向"空格/换行"而不是通用 URL 提示。
  assert.match(
    checkAbsoluteUrl('sk-xx https://api.openai.com/v1'),
    /空格\/换行/,
  )
  assert.equal(checkAbsoluteUrl('https://api.openai.com/v1'), null)
  assert.equal(checkAbsoluteUrl('http://localhost:11434/v1'), null)
  // 结尾斜杠 / query / fragment 都合法（真实场景常见，不能一律拒绝）。
  assert.equal(checkAbsoluteUrl('https://api.openai.com/v1/'), null)
  assert.equal(checkAbsoluteUrl('https://api.openai.com/v1?x=1'), null)
  // 首尾空格会被 trim，正常通过。
  assert.equal(checkAbsoluteUrl('  https://api.openai.com/v1  '), null)
})

test('未知 method 直接返回 null，不做假校验', () => {
  assert.equal(validateCommandParams('not.a.command', { any: 'thing' }), null)
})

// schemaFor 现在按 method 缓存（含"未知/转换失败"缓存为 null），
// 保证渲染路径反复调用不会重算 toJSONSchema，且降级行为不变。
test('contractRangeHint：缓存后结果稳定，未知命令与未知字段都返回 undefined', () => {
  const once = contractRangeHint('provider.configure', 'temperature')
  const twice = contractRangeHint('provider.configure', 'temperature')
  assert.equal(twice, once)
  assert.ok(once)
  // 未知 method：不抛错、无提示。
  assert.equal(contractRangeHint('not.a.command', 'temperature'), undefined)
  // 已知 method + 未知字段：不抛错、无提示。
  assert.equal(
    contractRangeHint('provider.configure', 'notAField.nested'),
    undefined,
  )
})
