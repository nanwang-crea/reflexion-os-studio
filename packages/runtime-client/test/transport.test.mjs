import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeTransport } from '../dist/index.js'

/** 捕获 listen 回调，用于在调度层驱动 bootstrap:message。 */
function makeTransport() {
  let handlerRef
  const transport = new RuntimeTransport({
    invoke: async (command) => {
      assert.equal(command, 'runtime_request')
      // 用请求中的 requestId 数字作为 JSON-RPC id（简化）。
      return 1
    },
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

test('response matching its command schema is resolved', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const pending = transport.request('project.list', {})
  // 让 request() 完成 invoke 并注册 pending 后，再投递响应。
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver({ id: 1, result: { projects: [] } })
  const value = await pending
  assert.deepEqual(value, { projects: [] })
})

test('response violating its command schema is rejected', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const pending = transport.request('project.list', {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  // project.list 要求 result.projects 为数组：缺字段应被判为响应校验失败。
  deliver({ id: 1, result: {} })
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /validation failed/)
    assert.match(error.message, /project\.list/)
    return true
  })
})

test('unknown command responses bypass validation unchanged', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const pending = transport.request('weird.unknown_command', {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver({ id: 1, result: { anything: true } })
  const value = await pending
  assert.deepEqual(value, { anything: true })
})

test('response arriving before invoke ack is validated and resolved', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  // 先投递响应（进入 earlyResponses 暂存），再发起请求。
  deliver({ id: 1, result: { projects: [] } })
  const value = await transport.request('project.list', {})
  assert.deepEqual(value, { projects: [] })
})

test('-32602 data 数组被并入 TransportError.message（不再吞原因）', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const pending = transport.request('provider.configure', {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver({
    id: 1,
    error: {
      code: -32602,
      message: 'Invalid params',
      data: [
        'baseUrl: Base URL需是带协议的完整 URL，如 https://api.example.com/v1',
      ],
    },
  })
  await assert.rejects(pending, (error) => {
    // message 保留协议枚举，同时把 data 拼上，供只 catch Error.message 的调用点使用。
    assert.match(error.message, /^Invalid params：baseUrl: Base URL/)
    // 结构化明细仍在 runtimeError.data 上，供需要按字段渲染的 UI 使用。
    assert.deepEqual(error.runtimeError?.data, [
      'baseUrl: Base URL需是带协议的完整 URL，如 https://api.example.com/v1',
    ])
    return true
  })
})

test('invoke 前到达的 -32602 也走同一 enrich（早到响应不吞原因）', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  // 响应先入 earlyResponses；request() 走的是"早到分支"，同样要 enrich。
  deliver({
    id: 1,
    error: {
      code: -32602,
      message: 'Invalid params',
      data: ['temperature: Temperature过大（应 ≤2）'],
    },
  })
  await assert.rejects(transport.request('provider.configure', {}), (error) => {
    assert.match(error.message, /^Invalid params：temperature: Temperature/)
    return true
  })
})

test('data 非数组/为空时保留原 message（不误伤其他错误码）', async () => {
  const { transport, deliver } = makeTransport()
  await transport.attach()
  const pending = transport.request('run.cancel', {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  deliver({
    id: 1,
    error: { code: -32000, message: 'run not active', data: undefined },
  })
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, 'run not active')
    return true
  })
})
