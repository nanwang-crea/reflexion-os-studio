import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolRegistry, runAgentLoop } from '../dist/index.js'

const request = { id: 'c1', name: 'read', arguments: '{}' }
function registry(execute) {
  const tools = new ToolRegistry()
  tools.register({
    name: 'read',
    description: 'fixture',
    parameters: { type: 'object', properties: {} },
    execute,
  })
  return tools
}

for (const name of ['AbortError', 'TimeoutError']) {
  test(`local ${name} is a tool failure and the Agent continues`, async () => {
    const tools = registry(async () => {
      throw new DOMException('local timeout', name)
    })
    const signal = new AbortController().signal
    let turns = 0
    let result
    const outcome = await runAgentLoop({
      history: [{ role: 'user', content: 'research' }],
      tools: tools.specs(),
      signal,
      callModel: async () =>
        ++turns === 1
          ? { content: '', finishReason: 'tool_calls', toolCalls: [request] }
          : { content: 'continued', finishReason: 'stop', toolCalls: [] },
      executeToolBatch: async (requests) => {
        result = await tools.call(requests[0], signal)
        return [result]
      },
    })
    assert.equal(result.isError, true)
    assert.equal(result.code, 'tool_error')
    assert.equal(result.replayUnsafe, true)
    assert.equal(signal.aborted, false)
    assert.equal(turns, 2)
    assert.equal(outcome.status, 'completed')
  })
}

for (const phase of ['before', 'during']) {
  test(`Run cancellation propagates (${phase}) with its original reason`, async () => {
    const controller = new AbortController()
    const reason = new Error('run budget exceeded')
    let invoked = false
    const tools = registry(async () => {
      invoked = true
      controller.abort(reason)
      throw new DOMException('aborted', 'AbortError')
    })
    if (phase === 'before') controller.abort(reason)
    await assert.rejects(
      tools.call(request, controller.signal),
      (error) => error === reason,
    )
    assert.equal(invoked, phase !== 'before')
  })
}

for (const isError of [false, true]) {
  test(`a returned tool result survives late cancellation for audit (isError=${isError})`, async () => {
    const controller = new AbortController()
    const result = { content: 'completed operation output', isError }
    const tools = registry(async () => {
      controller.abort()
      return result
    })
    assert.equal(await tools.call(request, controller.signal), result)
    assert.equal(controller.signal.aborted, true)
  })
}
