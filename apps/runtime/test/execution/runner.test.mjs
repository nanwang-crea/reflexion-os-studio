import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunRunner } from '../../dist/agent/run/runner.js'
import { createFileEditBatchTool } from '../../dist/agent/tools/file-writing/batch.js'
import { fixture, deferred } from './fixture.mjs'

const event = (value) => `data: ${JSON.stringify(value)}\n\n`
const completed = event({
  type: 'response.completed',
  response: {
    status: 'completed',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
})
function callEvents(name, args) {
  const item = {
    type: 'function_call',
    id: 'item',
    call_id: 'call',
    name,
    arguments: JSON.stringify(args),
  }
  return (
    event({
      type: 'response.output_item.added',
      item: { ...item, arguments: '' },
    }) +
    event({
      type: 'response.function_call_arguments.delta',
      item_id: 'item',
      delta: JSON.stringify(args),
    }) +
    event({ type: 'response.output_item.done', item })
  )
}
function input(f, maxToolCalls = 5) {
  return {
    ...f,
    provider: {
      baseUrl: 'https://mock.invalid',
      apiKey: 'test',
      model: 'm',
      apiFormat: 'openai-responses',
      maxRetries: 0,
    },
    buildHistory: async () => [{ role: 'user', content: 'task' }],
    settings: { maxTurns: 3, maxToolCalls },
    controller: new AbortController(),
    firstAssistantMessage: f.message,
  }
}

test(
  'Runner reads before model completion, consumes one budget slot, and never executes the read twice',
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      started = deferred()
    let count = 0,
      modelFinished = false,
      bodyController
    f.registry.register({
      name: 'file.read',
      description: 'read',
      parameters: { type: 'object' },
      execution: { effect: 'read' },
      execute: async () => {
        assert.equal(modelFinished, false)
        count++
        started.resolve()
        return { content: 'read content', isError: false }
      },
    })
    const original = globalThis.fetch
    let requests = 0
    globalThis.fetch = async (_url, options) => {
      requests++
      if (requests > 1)
        return new Response(
          event({ type: 'response.output_text.delta', delta: 'done' }) +
            completed,
        )
      const name = JSON.parse(options.body).tools[0].name
      return new Response(
        new ReadableStream({
          start(controller) {
            bodyController = controller
            controller.enqueue(
              new TextEncoder().encode(callEvents(name, { path: 'a.ts' })),
            )
          },
        }),
      )
    }
    t.after(() => {
      globalThis.fetch = original
    })
    const pending = new RunRunner(f.store).execute(input(f, 1))
    await started.promise
    assert.equal(count, 1)
    modelFinished = true
    bodyController.enqueue(new TextEncoder().encode(completed))
    bodyController.close()
    await pending
    assert.equal(f.store.runs.get(f.run.id).status, 'completed')
    assert.equal(count, 1)
    const metrics = f.store.runs.get(f.run.id).performance
    assert.equal(metrics.streamedReads, 1)
    assert.equal(metrics.toolCalls, 1)
    assert.equal(metrics.modelCalls, 2)
    assert.equal(metrics.requestAttempts, 2)
    assert.equal(f.store.toolCalls.listByRun(f.run.id).length, 1)
  },
)

test('Runner rejects a multi-file batch over budget before any file executes', async (t) => {
  const f = fixture(t)
  let count = 0
  f.registry.register(createFileEditBatchTool())
  f.registry.register({
    name: 'file.edit',
    description: 'edit',
    parameters: { type: 'object' },
    execute: async () => {
      count++
      return { content: 'edited', isError: false }
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const name = JSON.parse(options.body).tools.find((tool) =>
      tool.description.includes('16'),
    ).name
    const edit = (path) => ({
      path,
      edits: [{ kind: 'replace', oldText: 'a', newText: 'b' }],
    })
    return new Response(
      callEvents(name, { files: [edit('a.ts'), edit('b.ts')] }) + completed,
    )
  }
  t.after(() => {
    globalThis.fetch = original
  })
  await new RunRunner(f.store).execute(input(f, 2))
  assert.equal(count, 0)
  assert.equal(f.store.runs.get(f.run.id).errorCode, 'tool_call_budget')
})
