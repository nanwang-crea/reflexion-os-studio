export const options = {
  baseUrl: 'https://mock.invalid',
  apiKey: 'test',
  model: 'mock',
  signal: new AbortController().signal,
  maxRetries: 0,
}
export const start = (index, content_block) => ({
  type: 'content_block_start',
  index,
  content_block,
})
const delta = (index, delta) => ({ type: 'content_block_delta', index, delta })
export const stop = (index) => ({ type: 'content_block_stop', index })
export const anthropicBlocks = [
  { type: 'thinking', thinking: '先分析', signature: 'signature-1' },
  { type: 'redacted_thinking', data: 'opaque-redacted' },
  { type: 'text', text: '读取中' },
  { type: 'tool_use', id: 'tool-1', name: 'file_read', input: { path: 'a' } },
  { type: 'thinking', thinking: '再检查', signature: 'signature-2' },
  { type: 'tool_use', id: 'tool-2', name: 'file_read', input: {} },
]
export const anthropicEvents = [
  start(0, { type: 'thinking', thinking: '', signature: '' }),
  delta(0, { type: 'thinking_delta', thinking: '先分析' }),
  delta(0, { type: 'signature_delta', signature: 'signature-' }),
  delta(0, { type: 'signature_delta', signature: '1' }),
  stop(0),
  start(1, anthropicBlocks[1]),
  stop(1),
  start(2, { type: 'text', text: '' }),
  delta(2, { type: 'text_delta', text: '读取中' }),
  stop(2),
  start(3, { type: 'tool_use', id: 'tool-1', name: 'file_read', input: {} }),
  delta(3, { type: 'input_json_delta', partial_json: '{"path":' }),
  delta(3, { type: 'input_json_delta', partial_json: '"a"}' }),
  stop(3),
  start(4, anthropicBlocks[4]),
  stop(4),
  start(5, anthropicBlocks[5]),
  stop(5),
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
]
export const responsesItems = [
  {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'summary' }],
    encrypted_content: 'opaque-reasoning',
    status: 'completed',
  },
  {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '读取中', annotations: [] }],
  },
  {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'file_read',
    arguments: '{"path":"a"}',
    status: 'completed',
  },
]
export const responsesEvents = [
  { type: 'response.reasoning_summary_text.delta', delta: 'summary' },
  { type: 'response.output_text.delta', delta: '读取中' },
  ...responsesItems.map((item, output_index) => ({
    type: 'response.output_item.done',
    output_index,
    item,
  })),
  {
    type: 'response.completed',
    response: { status: 'completed', output: responsesItems },
  },
]

export async function withMock(events, fn) {
  const originalFetch = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, request) => {
    bodies.push(JSON.parse(request.body))
    const nextEvents =
      typeof events === 'function' ? events(bodies.length) : events
    return new Response(
      nextEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    )
  }
  try {
    return await fn(bodies)
  } finally {
    globalThis.fetch = originalFetch
  }
}
