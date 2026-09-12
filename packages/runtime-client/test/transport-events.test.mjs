import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeTransport } from '../dist/index.js'

/** 捕获 listen 回调，用于在调度层驱动 bootstrap:message（与 transport.test.mjs 同构）。 */
function makeTransport() {
  let handlerRef
  const transport = new RuntimeTransport({
    invoke: async () => 1,
    listen: async (_event, handler) => {
      handlerRef = handler
      return async () => undefined
    },
  })
  return {
    transport,
    deliver: (message) => handlerRef({ payload: { name: 'runtime', message } }),
  }
}

const VALID_DELTA = {
  jsonrpc: '2.0',
  method: 'message.delta',
  params: {
    protocolVersion: '1.1',
    eventId: 'e1',
    scope: 'run',
    runId: 'r1',
    seq: 0,
    occurredAt: '2026-09-12T00:00:00.000Z',
    type: 'message.delta',
    messageId: 'm1',
    chunkSeq: 0,
    delta: 'hi',
  },
}

test('合法事件经 onEvent 分发；畸形事件丢弃且必须留日志', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const got = []
  transport.onEvent((event) => got.push(event))
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    deliver(VALID_DELTA)
    // 旧信封（缺 scope）必须被拒并告警，不允许静默蒸发。
    const legacy = { ...VALID_DELTA.params }
    delete legacy.scope
    deliver({ jsonrpc: '2.0', method: 'message.delta', params: legacy })
  } finally {
    console.warn = original
  }
  assert.equal(got.length, 1)
  assert.equal(got[0].type, 'message.delta')
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0]), /malformed event/)
})
