import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ToolRegistry,
  LoopGuard,
  runAgentLoop,
} from '@reflexion-os-studio/agent-core'
import { FileEditParameters } from '@reflexion-os-studio/contracts'
import { createFileEditTool } from '../dist/agent/tools/files-edit.js'
import { FileReadState } from '../dist/agent/tools/read-state.js'
import { streamChat } from '../dist/provider.js'
import { PRIMARY_AGENT_SYSTEM_PROMPT } from '../dist/agent/prompts/primary-agent.js'

const signal = new AbortController().signal
function fixture() {
  let writes = 0
  const state = new FileReadState()
  state.record('timeline.md', {
    complete: true,
    revision: { modifiedMs: 1, sizeBytes: 10, sha256: 'a'.repeat(64) },
  })
  const registry = new ToolRegistry()
  registry.register(
    createFileEditTool(
      {
        request: async () => {
          writes++
          return { replacedCount: 1 }
        },
      },
      '/ws',
      state,
    ),
  )
  return { registry, writes: () => writes }
}

test('empty arguments get an actionable example and can recover on the next turn', async () => {
  const { registry, writes } = fixture()
  let turns = 0
  const outcome = await runAgentLoop({
    history: [{ role: 'user', content: 'Correct timeline.md' }],
    signal,
    callModel: async (messages) => {
      turns++
      if (turns === 2) {
        const error = messages.at(-1).content
        assert.match(error, /arguments/)
        assert.match(error, /"path"/)
        assert.match(error, /"edits"/)
        assert.match(error, /不要原样重试/)
        assert.equal(writes(), 0)
      }
      return turns < 3
        ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: `call-${turns}`,
                name: 'file.edit',
                arguments:
                  turns === 1
                    ? ''
                    : JSON.stringify({
                        path: 'timeline.md',
                        edits: [
                          { kind: 'replace', oldText: 'old', newText: 'new' },
                        ],
                      }),
              },
            ],
          }
        : { content: 'done', finishReason: 'stop', toolCalls: [] }
    },
    executeToolBatch: (requests) =>
      Promise.all(
        requests.map((request) => registry.call(request, signal, 'grant')),
      ),
  })
  assert.equal(outcome.status, 'completed')
  assert.equal(writes(), 1)
})

test('top-level fields are visible while invalid and mixed calls remain rejected before execution', async () => {
  assert.equal(FileEditParameters.type, 'object')
  for (const field of ['path', 'edits', 'oldText', 'newText', 'expectedCount'])
    assert.ok(FileEditParameters.properties[field])
  const { registry, writes } = fixture()
  for (const args of [
    {},
    { path: 'timeline.md' },
    { path: 'timeline.md', edits: [] },
    { path: 'timeline.md', edits: [{ kind: 'insert_after', anchor: 'last' }] },
    {
      path: 'timeline.md',
      edits: [{ kind: 'replace', oldText: 'x', newText: 'y' }],
      oldText: 'x',
      newText: 'y',
    },
  ]) {
    const result = registry.validateRequest({
      id: 'bad',
      name: 'file.edit',
      arguments: JSON.stringify(args),
    })
    assert.equal(result.ok, false)
    assert.equal(result.result.code, 'invalid_request')
  }
  assert.equal(writes(), 0)
  const guard = new LoopGuard()
  const request = { id: 'empty', name: 'file.edit', arguments: '{}' }
  for (let i = 0; i < 2; i++) {
    assert.equal(guard.admit(request).verdict, 'allow')
    guard.recordExecution(request, await registry.call(request, signal), true)
  }
  assert.equal(guard.admit(request).code, 'no_progress')
  assert.match(PRIMARY_AGENT_SYSTEM_PROMPT, /chunkIndex/)
  assert.match(PRIMARY_AGENT_SYSTEM_PROMPT, /空对象或空 arguments/)
})

for (const dialect of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${dialect} receives the complete file.edit schema`, async (t) => {
    const originalFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })
    let body
    globalThis.fetch = async (_, request) => {
      body = JSON.parse(request.body)
      const events =
        dialect === 'openai-chat'
          ? [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]
          : dialect === 'openai-responses'
            ? [
                {
                  type: 'response.completed',
                  response: { status: 'completed' },
                },
              ]
            : [
                { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                { type: 'message_stop' },
              ]
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
          (dialect === 'openai-chat' ? 'data: [DONE]\n\n' : ''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const { registry } = fixture()
    await streamChat(
      {
        baseUrl: 'https://mock.invalid',
        apiKey: 'test',
        model: 'mock',
        messages: [{ role: 'user', content: 'edit' }],
        signal,
        maxRetries: 0,
        tools: registry.specs(),
      },
      dialect,
      () => {},
    )
    const schema =
      dialect === 'openai-chat'
        ? body.tools[0].function.parameters
        : dialect === 'anthropic'
          ? body.tools[0].input_schema
          : body.tools[0].parameters
    assert.deepEqual(schema, FileEditParameters)
    assert.ok(schema.properties.path)
    assert.ok(schema.properties.edits.items)
  })
}
