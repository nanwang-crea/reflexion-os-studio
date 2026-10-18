import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  AskUserParameters,
  AskUserInputSchema,
  BrowserExecuteJsonSchema,
  AgentBrowserPageExample,
} from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'
import { browserTools } from '../dist/agent/tools/browser.js'
import { createAskUserTool } from '../dist/agent/tools/ask-user.js'
import {
  redactBrowserCalls,
  validateToolAdmission,
} from '../dist/agent/run/browser-admission.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunEventEmitter } from '../dist/events.js'
import {
  PermissionGate,
  ApprovalGateway,
} from '../dist/agent/permissions/index.js'
import { streamChat } from '../dist/provider.js'

const signal = new AbortController().signal
const question = {
  header: '登录墙处理',
  question: '您希望如何继续？',
  options: [
    {
      id: 'login',
      label: '手动登录后继续',
      description: '在可见浏览器中操作。',
    },
    { id: 'public', label: '查找公开内容', description: '继续查找公开信息。' },
  ],
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reflexion-tool-args-'))
  const store = new Store(directory)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'test',
    model: 'test',
  })
  let browserCalls = 0
  const questions = []
  const ctx = {
    store,
    sessionId: session.id,
    runId: run.id,
    projectId: null,
    browser: {
      enabled: true,
      call: async () => {
        browserCalls++
        throw new Error('unexpected browser execution')
      },
    },
    interactions: {
      requestQuestions: async (input) => {
        questions.push(input.questions)
        return [
          { questionId: input.questions[0].id, selectedOptionIds: ['public'] },
        ]
      },
    },
    system: { available: true },
    workspaceRoot: tmpdir(),
    skills: {},
    mcp: null,
    skillTools: {},
    childRunStarter: async () => {},
  }
  const registry = new ToolRegistry()
  registry.register(createAskUserTool(ctx))
  for (const tool of browserTools(ctx)) registry.register(tool)
  return {
    store,
    session,
    run,
    ctx,
    registry,
    questions,
    browserCalls: () => browserCalls,
  }
}
const request = (name, args, id = name) => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

function assertOptionalDefaults(schema, path) {
  if (!schema || typeof schema !== 'object') return
  for (const field of schema.required ?? [])
    assert.equal(
      Object.hasOwn(schema.properties?.[field] ?? {}, 'default'),
      false,
      `${path}.${field} has a default but is required`,
    )
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    assertOptionalDefaults(child, `${path}.${key}`)
  for (const child of [
    schema.items,
    schema.additionalProperties,
    ...Object.values(schema.$defs ?? {}),
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
  ])
    assertOptionalDefaults(child, path)
}

test('all builtin tools expose their fields and examples pass admission', (t) => {
  const f = fixture(t)
  const registry = createToolRegistry(f.ctx)
  assert.ok(registry.specs().length >= 30)
  for (const spec of registry.specs()) {
    assert.equal(spec.parameters.type, 'object', spec.name)
    assertOptionalDefaults(spec.parameters, spec.name)
    if (spec.parameters.oneOf || spec.parameters.anyOf)
      assert.ok(Object.keys(spec.parameters.properties).length > 0, spec.name)
    for (const args of spec.parameters.examples ?? []) {
      assert.equal(
        validateToolAdmission(registry, request(spec.name, args)).ok,
        true,
        spec.name,
      )
    }
  }
  assert.deepEqual(BrowserExecuteJsonSchema.properties.mode.enum, [
    'actions',
    'script',
  ])
  assert.ok(BrowserExecuteJsonSchema.properties.steps)
  assert.ok(BrowserExecuteJsonSchema.properties.script)
})

test('browser.type allows omitted submit and passes false to the browser', async (t) => {
  const f = fixture(t)
  let received
  f.ctx.browser.call = async (_session, _run, _operation, args) => {
    received = args
    return { page: AgentBrowserPageExample, sourceUrl: 'https://example.com/' }
  }
  const result = await f.registry.call(
    request('browser.type', {
      page: AgentBrowserPageExample,
      ref: 'e1',
      element: '搜索框',
      text: '北京旅游',
    }),
    signal,
  )
  assert.equal(result.isError, false)
  assert.equal(received.submit, false)
})

test('question IDs and option IDs have distinct diagnostics; Chinese text survives correction', async (t) => {
  const f = fixture(t)
  const invalid = request('ask_user', { questions: [question] })
  const result = await f.registry.call(invalid, signal)
  assert.equal(result.code, 'invalid_request')
  assert.match(result.content, /\$\.questions\.0\.id/)
  assert.match(result.content, /选项 id 不会替代问题 id/)
  assert.equal(f.questions.length, 0)
  const valid = { questions: [{ id: 'login_choice', ...question }] }
  assert.equal(
    (await f.registry.call(request('ask_user', valid), signal)).isError,
    false,
  )
  assert.equal(f.questions[0][0].question, question.question)
  assert.equal(f.questions[0][0].id, 'login_choice')
  assert.deepEqual(
    AskUserInputSchema.parse(AskUserParameters.examples[0]),
    AskUserParameters.examples[0],
  )
  for (const args of [
    { questions: [valid.questions[0], valid.questions[0]] },
    {
      questions: [
        {
          ...valid.questions[0],
          options: [question.options[0], question.options[0]],
        },
      ],
    },
  ]) {
    const duplicate = await f.registry.call(request('ask_user', args), signal)
    assert.equal(duplicate.code, 'invalid_request')
    assert.match(duplicate.content, /unique/)
  }
  assert.equal(f.questions.length, 1)
})

test('unsupported browser scripts retain their arguments and report compilation rather than missing fields', (t) => {
  const f = fixture(t)
  const call = request('browser.execute', {
    page: AgentBrowserPageExample,
    mode: 'script',
    script: "await page.evaluate('document.title')",
  })
  assert.equal(redactBrowserCalls([call])[0].arguments, call.arguments)
  const result = validateToolAdmission(f.registry, call)
  assert.equal(result.ok, false)
  assert.match(result.result.content, /script 不能编译/)
  assert.doesNotMatch(result.result.content, /required property 'page'/)
  assert.equal(f.browserCalls(), 0)
  for (const args of [
    { page: AgentBrowserPageExample, mode: 'actions' },
    { page: AgentBrowserPageExample, mode: 'script' },
    {
      page: AgentBrowserPageExample,
      mode: 'script',
      script: 'await page.screenshot();',
      steps: [{ action: 'read' }],
    },
  ])
    assert.equal(
      validateToolAdmission(f.registry, request('browser.execute', args)).ok,
      false,
    )
  const malformed = {
    id: 'json',
    name: 'browser.execute',
    arguments: '{"mode":',
  }
  assert.equal(
    redactBrowserCalls([malformed])[0].arguments,
    malformed.arguments,
  )
  assert.match(
    f.registry.validateRequest(malformed).result.content,
    /not valid JSON/,
  )
  const secretUrl = request('browser.navigate', {
    url: 'https://sample:synthetic-password@example.com',
  })
  const redacted = redactBrowserCalls([secretUrl])[0]
  assert.doesNotMatch(redacted.arguments, /synthetic-password/)
  assert.equal(validateToolAdmission(f.registry, redacted).ok, false)
  const quoted = request('browser.navigate', {
    url: 'https://sample:synthetic"password@example.com/',
  })
  const sanitized = redactBrowserCalls([quoted])[0]
  assert.doesNotMatch(sanitized.arguments, /synthetic/)
  assert.equal(validateToolAdmission(f.registry, sanitized).ok, false)
})

for (const dialect of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${dialect} receives complete browser and question schemas`, async (t) => {
    const f = fixture(t)
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    let body
    globalThis.fetch = async (_, options) => {
      body = JSON.parse(options.body)
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
    await streamChat(
      {
        baseUrl: 'https://mock.invalid',
        apiKey: 'test',
        model: 'test',
        messages: [{ role: 'user', content: 'task' }],
        signal,
        maxRetries: 0,
        tools: f.registry.specs(),
      },
      dialect,
      () => {},
    )
    for (const [index, spec] of f.registry.specs().entries()) {
      const tool = body.tools[index]
      const schema =
        dialect === 'openai-chat'
          ? tool.function.parameters
          : dialect === 'anthropic'
            ? tool.input_schema
            : tool.parameters
      assert.deepEqual(schema, spec.parameters)
    }
  })
}

function sse(calls) {
  const delta = calls
    ? {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    : { content: '已收到选择，继续处理。' }
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('Run can correct question fields after browser script rejection without losing original diagnostics', async (t) => {
  const f = fixture(t)
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let count = 0
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body)
    count++
    if (count === 1)
      return sse([
        request(
          'browser.execute',
          {
            page: AgentBrowserPageExample,
            mode: 'script',
            script: "await page.evaluate('document.title')",
          },
          'bad-script',
        ),
        request('ask_user', { questions: [question] }, 'bad-question'),
      ])
    if (count === 2) {
      assert.match(JSON.stringify(body.messages), /script 不能编译/)
      assert.match(JSON.stringify(body.messages), /\$\.questions\.0\.id/)
      const assistant = body.messages.find(
        (message) => message.tool_calls?.length,
      )
      assert.equal(
        JSON.parse(assistant.tool_calls[0].function.arguments).mode,
        'script',
      )
      return sse([
        request(
          'ask_user',
          { questions: [{ id: 'login_choice', ...question }] },
          'fixed-question',
        ),
      ])
    }
    return sse()
  }
  await new RunRunner(f.store).execute({
    run: f.run,
    provider: {
      baseUrl: 'https://mock.invalid',
      apiKey: 'test',
      model: 'test',
      maxRetries: 0,
    },
    buildHistory: async () => [
      { role: 'user', content: '查询北京旅游，必要时询问我。' },
    ],
    registry: f.registry,
    workspaceRoot: null,
    gate: new PermissionGate({
      preset: 'workspace-read',
      hasWorkspace: false,
      approvalOverride: 'default',
      dangerActive: () => false,
    }),
    approvals: new ApprovalGateway(),
    settings: { maxTurns: 4 },
    controller: new AbortController(),
    emitter: new RunEventEmitter(f.run.id, () => {}),
    firstAssistantMessage: f.store.messages.create({
      sessionId: f.session.id,
      runId: f.run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    }),
  })
  assert.equal(f.store.runs.get(f.run.id).status, 'completed')
  assert.equal(f.browserCalls(), 0)
  assert.equal(f.questions.length, 1)
  const calls = f.store.toolCalls.listByRun(f.run.id)
  assert.equal(calls[0].args.mode, 'script')
  assert.match(calls[0].output.content, /script 不能编译/)
  assert.equal(calls[2].status, 'completed')
})
