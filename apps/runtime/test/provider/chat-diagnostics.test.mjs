import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChatCompletion } from '../../dist/provider.js'

const choice = (finish_reason, extra = {}) => ({
  choices: [{ delta: {}, finish_reason, ...extra }],
})
const usage = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }
const sse = (events, done = true) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
  (done ? 'data: [DONE]\n\n' : '')

function setup(t, bodies, overrides = {}) {
  let calls = 0
  const retries = []
  const logs = []
  t.mock.method(process.stderr, 'write', (line) => {
    logs.push(JSON.parse(line))
    return true
  })
  t.mock.method(globalThis, 'fetch', async () => {
    const body = bodies[Math.min(calls++, bodies.length - 1)]
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  return {
    run: () =>
      streamChatCompletion(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: 'test-key-private',
          model: 'mock',
          messages: [],
          signal: new AbortController().signal,
          maxRetries: 1,
          retryBackoffInitialMs: 0,
          onRetry: (retry) => retries.push(retry),
          ...overrides,
        },
        () => {},
      ),
    get calls() {
      return calls
    },
    retries,
    logs,
  }
}

function stats(error) {
  return JSON.parse(error.message.split('streamStats: ')[1])
}

for (const tail of [[usage], [choice(null)], [choice('stop')]]) {
  test(`unknown terminal survives ${JSON.stringify(tail)}`, async (t) => {
    const mock = setup(t, [sse([choice('mystery'), ...tail])])
    await assert.rejects(mock.run(), (error) => {
      assert.equal(error.code, 'provider_protocol')
      assert.match(error.message, /unsupported finish_reason.*mystery/)
      assert.equal(stats(error).terminalState, 'unsupported')
      return true
    })
    assert.equal(mock.calls, 1)
    assert.equal(mock.retries.length, 0)
  })
}

test('first unsupported terminal is preserved after a valid terminal', async (t) => {
  const mock = setup(t, [
    sse([
      choice('stop'),
      choice('first-unknown'),
      choice('second-unknown'),
      usage,
    ]),
  ])
  await assert.rejects(mock.run(), (error) => {
    assert.match(error.message, /first-unknown/)
    assert.doesNotMatch(error.message, /second-unknown/)
    assert.equal(stats(error).unsupportedFinishFields, 2)
    return true
  })
  assert.equal(mock.calls, 1)
})

for (const [state, events] of [
  ['absent', [{ choices: [{ delta: { content: 'partial' } }] }, usage]],
  ['null_only', [choice(null), usage]],
]) {
  test(`${state} retries and resets per-request counters`, async (t) => {
    const mock = setup(t, [sse(events), sse([choice('stop'), usage])])
    const result = await mock.run()
    assert.equal(result.finishReason, 'stop')
    assert.equal(mock.calls, 2)
    assert.equal(mock.retries.length, 1)
    const failureStats = stats({ message: mock.retries[0].reason })
    assert.equal(failureStats.terminalState, state)
    assert.equal(failureStats.finishFields, state === 'absent' ? 0 : 1)
    assert.equal(mock.logs[0].terminalState, state)
    assert.equal(mock.logs[1].terminalState, 'valid')
    assert.equal(mock.logs[1].contentChars, 0)
    assert.notEqual(
      mock.logs[0].requestAttemptId,
      mock.logs[1].requestAttemptId,
    )
  })
}

for (const raw of [
  '',
  42,
  false,
  { secret: 'untrusted-object-secret' },
  ['x'],
]) {
  test(`invalid terminal type ${typeof raw} never retries`, async (t) => {
    const mock = setup(t, [sse([choice(raw), usage])])
    await assert.rejects(mock.run(), (error) => {
      assert.equal(stats(error).terminalState, 'unsupported')
      assert.doesNotMatch(error.message, /untrusted-object-secret/)
      return true
    })
    assert.equal(mock.calls, 1)
  })
}

test('valid terminal survives usage, null, and missing finish fields', async (t) => {
  const mock = setup(t, [
    sse([choice('stop'), usage, choice(null), { choices: [{ delta: {} }] }]),
  ])
  const result = await mock.run()
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.rawStopReason, 'stop')
  assert.equal(mock.calls, 1)
})

test('diagnostics count events without leaking payloads or credentials', async (t) => {
  const body =
    ': private-comment\nevent: private-event-name\ndata: \n\n' +
    sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              content: 'private-content',
              reasoning_content: 'private-reasoning',
              tool_calls: [
                {
                  index: 0,
                  id: 'private-tool-id',
                  function: { name: 'private-tool', arguments: 'private-args' },
                },
              ],
            },
          },
          { index: 3, delta: { content: 'ignored-choice' } },
        ],
      },
      choice('test-key-private header-private Bearer hidden-token'),
      usage,
    ])
  const mock = setup(t, [body], {
    headers: [{ name: 'X-Private', value: 'header-private' }],
  })
  await assert.rejects(mock.run(), (error) => {
    const counts = stats(error)
    assert.equal(counts.dataEvents, 5)
    assert.equal(counts.jsonEvents, 3)
    assert.equal(counts.doneEvents, 1)
    assert.equal(counts.commentLines, 1)
    assert.equal(counts.otherLines, 1)
    assert.equal(counts.emptyDataEvents, 1)
    assert.equal(counts.nonzeroChoiceEvents, 1)
    assert.equal(counts.contentChars, 'private-content'.length)
    assert.equal(counts.reasoningChars, 'private-reasoning'.length)
    assert.equal(counts.toolCallChunks, 1)
    assert.equal(counts.toolArgumentChars, 'private-args'.length)
    const exposed = error.message + JSON.stringify(mock.logs)
    for (const secret of [
      'test-key-private',
      'header-private',
      'hidden-token',
      'private-content',
      'private-reasoning',
      'private-args',
      'private-tool',
      'private-tool-id',
      'private-comment',
      'private-event-name',
      'ignored-choice',
    ])
      assert.ok(!exposed.includes(secret), secret)
    return true
  })
})

test('socket failure retains counters and network classification', async (t) => {
  let pull = 0
  const socketError = new Error('other side closed')
  socketError.code = 'UND_ERR_SOCKET'
  const body = new ReadableStream({
    pull(controller) {
      if (pull++ === 0) {
        controller.enqueue(new TextEncoder().encode(sse([choice(null)], false)))
      } else
        controller.error(new TypeError('terminated', { cause: socketError }))
    },
  })
  const mock = setup(t, [body], { maxRetries: 0 })
  await assert.rejects(mock.run(), (error) => {
    assert.equal(error.code, 'network')
    assert.match(error.message, /UND_ERR_SOCKET/)
    assert.equal(stats(error).jsonEvents, 1)
    assert.equal(stats(error).terminalState, 'null_only')
    return true
  })
})

test('unknown terminal at EOF is not misclassified as missing DONE', async (t) => {
  const mock = setup(t, [sse([choice('mystery'), usage], false)])
  await assert.rejects(mock.run(), (error) => {
    assert.equal(error.code, 'provider_protocol')
    assert.match(error.message, /mystery/)
    assert.equal(stats(error).doneEvents, 0)
    return true
  })
  assert.equal(mock.calls, 1)
})
