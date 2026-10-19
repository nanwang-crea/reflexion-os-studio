import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  estimateMessageTokens,
  estimateTokens,
} from '@reflexion-os-studio/agent-core'
import {
  summarizeCheckpointFrames,
  ensureCheckpoint,
  transcriptOf,
} from '../../dist/agent/context/context-checkpoint.js'
import { transcriptChunks } from '../../dist/agent/context/checkpoint/transcript.js'
import {
  SUMMARY,
  provider,
  input,
  summaryResponse,
  memoryCheckpoint,
} from './checkpoint-fixtures.mjs'

for (const [apiFormat, path] of [
  ['openai-chat', '/chat/completions'],
  ['anthropic', '/v1/messages'],
  ['openai-responses', '/v1/responses'],
]) {
  test(`summary uses ${apiFormat} routing, bounded output and native authentication`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, request) => {
      assert.equal(new URL(url).pathname, path)
      const body = JSON.parse(request.body)
      assert.equal(body.tools, undefined)
      assert.equal(
        apiFormat === 'openai-responses'
          ? body.max_output_tokens
          : (body.max_tokens ?? body.max_completion_tokens),
        4096,
      )
      if (apiFormat === 'anthropic')
        assert.equal(request.headers['x-api-key'], provider.apiKey)
      else
        assert.equal(
          request.headers.Authorization ?? request.headers.authorization,
          `Bearer ${provider.apiKey}`,
        )
      return summaryResponse(undefined, 'stop', apiFormat)
    })
    assert.deepEqual(
      await summarizeCheckpointFrames({ ...provider, apiFormat }, input()),
      SUMMARY,
    )
  })
}

test('complete summary input includes late user corrections, tool arguments and error tails', async (t) => {
  const frames = Array.from({ length: 40 }, (_, i) => ({
    kind: 'user',
    content:
      `message-${i}:` +
      'a'.repeat(400) +
      (i === 39 ? ' preserve-last-constraint' : ''),
  }))
  frames.push({
    kind: 'tool_round',
    assistant: {
      role: 'assistant',
      content: 'tool work',
      toolCalls: [
        {
          id: 'c1',
          name: 'file.edit',
          arguments: '{"path":"important-target.ts"}',
        },
      ],
    },
    results: [
      {
        role: 'tool',
        toolCallId: 'c1',
        isError: true,
        content: 'prefix'.repeat(100) + ' useful-error-tail',
      },
    ],
  })
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body)
    const source = body.messages[1].content
    assert.ok(source.includes('preserve-last-constraint'))
    assert.ok(source.includes('important-target.ts'))
    assert.ok(source.includes('useful-error-tail'))
    return summaryResponse()
  })
  await summarizeCheckpointFrames(provider, { ...input(), newFrames: frames })
})

test('long frames are fully consumed in bounded incremental requests before committing the watermark', async (t) => {
  const fixture = memoryCheckpoint('multi-batch')
  const frames = [
    { kind: 'user', content: '中'.repeat(36000) + ' tail-constraint' },
  ]
  let calls = 0
  let seen = ''
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    calls++
    assert.equal(fixture.commits, 0)
    const body = JSON.parse(request.body)
    assert.ok(estimateMessageTokens(body.messages) <= 11000)
    if (calls > 1)
      assert.ok(body.messages[1].content.includes(`batch-${calls - 1}`))
    seen += body.messages[1].content.split(
      '新增对话片段（原文按顺序分批；一条消息可能跨批次）：\n\n',
    )[1]
    return summaryResponse(
      JSON.stringify({ ...SUMMARY, goal: `batch-${calls}` }),
    )
  })
  const config = { ...provider, contextWindow: 16000, maxTokens: 1000 }
  const result = await ensureCheckpoint({
    ...fixture.options(),
    store: fixture.store,
    provider: config,
    stableFrames: frames,
    summarize: (value) => summarizeCheckpointFrames(config, value),
  })
  assert.equal(result.failed, false)
  assert.ok(calls > 1)
  assert.equal(seen, transcriptOf(frames))
  assert.equal(fixture.commits, 1)
  assert.equal(fixture.row.throughMessageId, 'm1')
})

test('a later batch failure leaves the previous committed checkpoint untouched', async (t) => {
  const fixture = memoryCheckpoint('batch-failure')
  await ensureCheckpoint({ ...fixture.options(), store: fixture.store })
  const before = fixture.row
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return summaryResponse(
      calls === 1 ? JSON.stringify(SUMMARY) : '{"wrong":"shape"}',
    )
  })
  const config = { ...provider, contextWindow: 16000, maxTokens: 1000 }
  const result = await ensureCheckpoint({
    ...fixture.options(),
    store: fixture.store,
    provider: config,
    stableFrames: [{ kind: 'user', content: '新'.repeat(36000) }],
    summarize: (value) => summarizeCheckpointFrames(config, value),
  })
  assert.ok(calls > 1)
  assert.equal(result.failed, true)
  assert.equal(fixture.row, before)
  assert.equal(fixture.commits, 1)
})

for (const [text, reason] of [
  ['{"wrong":"shape"}', 'stop'],
  [JSON.stringify(SUMMARY), 'length'],
  ['not JSON', 'stop'],
]) {
  test(`summary rejects invalid or incomplete result: ${reason}/${text.slice(0, 16)}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      summaryResponse(text, reason),
    )
    await assert.rejects(summarizeCheckpointFrames(provider, input()))
  })
}

test('summary-specific chunking preserves all Unicode characters and image references without payload bytes', () => {
  const frames = [
    {
      kind: 'user',
      content: '中a😀'.repeat(500),
      images: [
        {
          type: 'image',
          assetId: 'image-id',
          mimeType: 'image/png',
          base64: 'excluded-image-bytes',
        },
      ],
    },
  ]
  const chunks = [...transcriptChunks(frames, () => 40)]
  assert.ok(chunks.every((chunk) => estimateTokens(chunk) <= 40))
  assert.equal(chunks.join(''), transcriptOf(frames))
  assert.ok(!chunks.some((chunk) => /[\uD800-\uDBFF]$/.test(chunk)))
  assert.ok(chunks.join('').includes('image-id'))
  assert.ok(!chunks.join('').includes('excluded-image-bytes'))
})
