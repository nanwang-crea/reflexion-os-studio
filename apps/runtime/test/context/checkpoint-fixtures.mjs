export const SUMMARY = {
  goal: 'audit task',
  constraints: [],
  decisions: [],
  completed: [],
  pending: [],
  toolFacts: [],
  knownErrors: [],
}
export const provider = {
  baseUrl: 'https://synthetic.invalid',
  apiKey: 'synthetic-key',
  model: 'synthetic-model',
  maxRetries: 0,
}
export const input = () => ({
  previousSummary: null,
  newFrames: [{ kind: 'user', content: 'summarize' }],
  signal: new AbortController().signal,
})

export function summaryResponse(
  text = JSON.stringify(SUMMARY),
  reason = 'stop',
  format = 'openai-chat',
) {
  let events
  if (format === 'anthropic')
    events = [
      {
        type: 'message_start',
        message: {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'synthetic-model',
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: reason === 'stop' ? 'end_turn' : 'max_tokens' },
      },
      { type: 'message_stop' },
    ]
  else if (format === 'openai-responses')
    events = [
      { type: 'response.output_text.delta', delta: text },
      {
        type: reason === 'stop' ? 'response.completed' : 'response.incomplete',
        response: {
          status: reason === 'stop' ? 'completed' : 'incomplete',
          ...(reason === 'stop'
            ? {}
            : { incomplete_details: { reason: 'max_output_tokens' } }),
        },
      },
    ]
  else
    events = [
      { choices: [{ delta: { content: text } }] },
      { choices: [{ delta: {}, finish_reason: reason }] },
    ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      (format === 'openai-chat' ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

export function memoryCheckpoint(sessionId = 'synthetic') {
  let row = null
  let commits = 0
  return {
    store: {
      contextCheckpoints: {
        get: () => row,
        upsert: (next) => {
          row = next
          commits++
          return row
        },
      },
    },
    get row() {
      return row
    },
    get commits() {
      return commits
    },
    options: () => ({
      sessionId,
      provider,
      stableFrames: [{ kind: 'user', content: 'source' }],
      stableIds: ['m1'],
      throughMessageId: 'm1',
      signal: new AbortController().signal,
      summarize: async () => SUMMARY,
    }),
  }
}
