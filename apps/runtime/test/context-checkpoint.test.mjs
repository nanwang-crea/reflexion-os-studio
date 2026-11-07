import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import {
  computeSourceHash,
  ensureCheckpoint,
  sanitizeSummary,
  filterSecretLine,
  resetCheckpointState,
  classifyCheckpointError,
} from '../dist/agent/context/context-checkpoint.js'

function freshStore() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-checkpoint-')))
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  // 真实消息作为 watermark 外键锚点（m1..m4）。
  for (const content of ['旧消息1', '旧回复1', '旧消息2', '旧回复2']) {
    store.messages.create({
      sessionId: session.id,
      runId: null,
      role: content.startsWith('旧回复') ? 'assistant' : 'user',
      content,
      status: 'completed',
    })
  }
  const ids = store.messages.listBySession(session.id).map((m) => m.id)
  return { store, session, m1: ids[0], m2: ids[1], m3: ids[2], m4: ids[3] }
}

function stableFrames() {
  return [
    { kind: 'system', content: 'sys' },
    { kind: 'user', content: '旧消息1' },
    { kind: 'assistant_text', content: '旧回复1' },
  ]
}

const SUMMARY = {
  goal: '完成重构',
  constraints: ['保持 API 兼容'],
  decisions: ['使用 Frame 压缩'],
  completed: ['读取文件'],
  pending: ['写测试'],
  toolFacts: ['src/a.ts 有 3 处引用'],
  knownErrors: ['首次编译失败：缺 import'],
}

function options(fixture, overrides = {}) {
  return {
    store: fixture.store,
    sessionId: fixture.session.id,
    provider: { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm' },
    summarize: async () => SUMMARY,
    stableFrames: stableFrames(),
    stableIds: [null, fixture.m1, fixture.m2],
    throughMessageId: fixture.m2,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('first ensure summarizes and upserts; second with same hash hits', async () => {
  const fixture = freshStore()
  let calls = 0
  const make = () =>
    options(fixture, {
      summarize: async () => {
        calls += 1
        return SUMMARY
      },
    })
  const first = await ensureCheckpoint(make())
  assert.equal(first.summarized, true)
  assert.equal(first.hit, false)
  assert.equal(calls, 1)
  const second = await ensureCheckpoint(make())
  assert.equal(second.hit, true)
  assert.equal(second.summarized, false)
  assert.equal(calls, 1, 'same source hash must not re-summarize')
  assert.deepEqual(second.summary, SUMMARY)
})

test('growing history triggers incremental summarize with previous summary and suffix only', async () => {
  const fixture = freshStore()
  await ensureCheckpoint(options(fixture))
  const inputs = []
  await ensureCheckpoint(
    options(fixture, {
      stableFrames: [
        ...stableFrames(),
        { kind: 'user', content: '旧消息2' },
        { kind: 'assistant_text', content: '旧回复2' },
      ],
      stableIds: [null, fixture.m1, fixture.m2, fixture.m3, fixture.m4],
      throughMessageId: fixture.m4,
      summarize: async (input) => {
        inputs.push(input)
        return SUMMARY
      },
    }),
  )
  assert.equal(inputs.length, 1)
  assert.deepEqual(inputs[0].previousSummary, SUMMARY)
  // 只摘要 watermark 之后的新增 Frame（m3/m4），不重摘旧窗口。
  assert.deepEqual(
    inputs[0].newFrames.map((f) => ('content' in f ? f.content : null)),
    ['旧消息2', '旧回复2'],
  )
})

test('summary content change invalidates old checkpoint (hash mismatch)', async () => {
  const fixture = freshStore()
  await ensureCheckpoint(options(fixture))
  // 历史被 retry/supersede 改动：hash 变化 → 旧 checkpoint 删除并重摘要。
  const calls = []
  await ensureCheckpoint(
    options(fixture, {
      stableFrames: [
        { kind: 'system', content: 'sys' },
        { kind: 'user', content: '旧消息1（改动）' },
        { kind: 'assistant_text', content: '旧回复1' },
      ],
      summarize: async () => {
        calls.push(1)
        return SUMMARY
      },
    }),
  )
  assert.equal(calls.length, 1)
  assert.equal(
    fixture.store.contextCheckpoints.get(fixture.session.id) !== null,
    true,
  )
})

test('summarizer failure cools down: same hash does not immediately retry', async () => {
  const fixture = freshStore()
  let calls = 0
  const make = () =>
    options(fixture, {
      summarize: async () => {
        calls += 1
        throw new Error('provider down')
      },
    })
  const first = await ensureCheckpoint(make())
  assert.equal(first.failed, true)
  const second = await ensureCheckpoint(make())
  assert.equal(second.failed, true)
  assert.equal(calls, 1, 'failed hash must not immediately re-request')
})

test('concurrent ensure with same key single-flights the model call', async () => {
  const fixture = freshStore()
  let calls = 0
  const make = () =>
    options(fixture, {
      summarize: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 20))
        return SUMMARY
      },
    })
  const [a, b, c] = await Promise.all([
    ensureCheckpoint(make()),
    ensureCheckpoint(make()),
    ensureCheckpoint(make()),
  ])
  assert.equal(calls, 1, 'concurrent identical requests must single-flight')
  assert.equal(a.summary.goal, '完成重构')
  assert.equal(b.summary.goal, '完成重构')
  assert.equal(c.summary.goal, '完成重构')
})

test('sanitizeSummary drops secret-looking lines and clamps to schema', () => {
  const sanitized = sanitizeSummary({
    goal: 'fetch https://api.example.com with sk-abcdefgh12345678',
    constraints: ['正常约束', 'api key: sk-abcdefgh12345678'],
    decisions: [],
    completed: [],
    pending: [],
    toolFacts: [],
    knownErrors: [],
  })
  assert.equal(sanitized.goal, null)
  assert.deepEqual(sanitized.constraints, ['正常约束'])
  assert.equal(filterSecretLine('Bearer abcdefgh12345'), null)
  assert.equal(filterSecretLine('普通内容'), '普通内容')
})

test('malformed summary shape is rejected before checkpoint commit', () => {
  assert.throws(() => sanitizeSummary({ wrong: 'shape' }), /invalid schema/)
})

test('computeSourceHash differs when tool result content changes', () => {
  const framesA = [
    {
      kind: 'tool_round',
      assistant: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'file.read', arguments: '{}' }],
      },
      results: [
        {
          role: 'tool',
          toolCallId: 'c1',
          content: 'old content',
          isError: false,
        },
      ],
    },
  ]
  const framesB = [
    {
      kind: 'tool_round',
      assistant: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'file.read', arguments: '{}' }],
      },
      results: [
        {
          role: 'tool',
          toolCallId: 'c1',
          content: 'new content',
          isError: false,
        },
      ],
    },
  ]
  assert.notEqual(computeSourceHash(framesA), computeSourceHash(framesB))
  assert.equal(computeSourceHash(framesA), computeSourceHash(framesA))
})

test('refresh failure reports stage/code and backs off per session', async () => {
  resetCheckpointState()
  const fixture = freshStore()
  const failures = []
  let calls = 0
  const fail = async () => {
    calls += 1
    throw new Error('checkpoint summary: no JSON object in response')
  }
  const runWith = (suffix) =>
    ensureCheckpoint(
      options(fixture, {
        summarize: fail,
        onFailure: (failure) => failures.push(failure),
        stableFrames: [
          ...stableFrames(),
          { kind: 'assistant_text', content: suffix },
        ],
      }),
    )
  const first = await runWith('a')
  assert.equal(first.failed, true)
  assert.equal(first.skipped, false)
  assert.deepEqual(failures[0], {
    stage: 'summarize',
    reason: 'summary_no_json',
  })
  assert.equal(calls, 1)
  // 不同 source hash 会绕过同 hash 冷却，但会话级退避仍应拦住重复摘要。
  const second = await runWith('b')
  assert.equal(second.failed, true)
  assert.equal(second.skipped, true)
  assert.equal(second.failure.reason, 'backoff')
  assert.equal(calls, 1, 'session backoff must stop repeated summaries')
})

test('validateSource failure is reported as source_changed and never commits', async () => {
  resetCheckpointState()
  const fixture = freshStore()
  const failures = []
  const result = await ensureCheckpoint(
    options(fixture, {
      summarize: async () => SUMMARY,
      validateSource: () => false,
      onFailure: (failure) => failures.push(failure),
    }),
  )
  assert.equal(result.failed, true)
  assert.equal(result.skipped, false)
  assert.deepEqual(failures[0], {
    stage: 'validate',
    reason: 'source_changed',
  })
  assert.equal(fixture.store.contextCheckpoints.get(fixture.session.id), null)
})

test('classifyCheckpointError maps provider codes and summary failures', () => {
  assert.equal(
    classifyCheckpointError(
      Object.assign(new Error('transport down'), { code: 'network' }),
    ),
    'provider_network',
  )
  assert.equal(
    classifyCheckpointError(
      new Error('checkpoint summary: output truncated (length)'),
    ),
    'summary_truncated',
  )
  assert.equal(
    classifyCheckpointError(
      new Error('checkpoint summary: no JSON object in response'),
    ),
    'summary_no_json',
  )
  assert.equal(
    classifyCheckpointError(
      new Error('checkpoint source changed during summarization'),
    ),
    'source_changed',
  )
  assert.equal(classifyCheckpointError(new Error('boom')), 'internal')
})
