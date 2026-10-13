import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from '../../dist/store/index.js'
import { ChatAgent } from '../../dist/agent/index.js'
import { saveSecret, deleteSecret } from '../../dist/secrets.js'
import { WorkflowService } from '../../dist/workflow/service.js'
import { AgentWorkflowExecutor } from '../../dist/workflow/execution/agent-executor.js'
import { saveWorkflowDefinition } from '../../dist/workflow/definitions/service.js'
import { workflowFixture } from '../../../../packages/contracts/test/fixtures/workflow.mjs'
import { until } from './harness.mjs'

async function fixture(t, mode) {
  assert.ok(
    process.env.REFLEXION_DATA_DIR?.includes('reflexion-test-data-'),
    'Use the test-data preloader',
  )
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-workflow-agent-'))
  const store = new Store(dir)
  const project = store.projects.create({ name: 'Synthetic', folderPath: dir })
  const secretRef = saveSecret('synthetic-workflow-key')
  let requests = 0,
    toolsExecuted = 0
  const bodies = [],
    events = []
  const server = createServer(async (request, response) => {
    let data = ''
    for await (const chunk of request) data += chunk
    const body = JSON.parse(data)
    bodies.push(body)
    ++requests
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (mode === 'pending') {
      response.write('data: {"choices":[{"delta":{"content":"pending"}}]}\n\n')
      return
    }
    if (
      mode === 'approval' &&
      !body.messages.some((message) => message.role === 'tool')
    ) {
      const name = body.tools.find(
        (tool) => tool.function.description === 'Synthetic MCP write',
      ).function.name
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests}`,
                    type: 'function',
                    function: { name, arguments: '{}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      )
      response.write(
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      )
    } else {
      const content =
        mode === 'invalid'
          ? 'not-json'
          : JSON.stringify({ text: { type: 'text', value: 'verified result' } })
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      )
      response.write(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      )
    }
    if (mode !== 'no-usage')
      response.write(
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5}}\n\n',
      )
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  store.providers.upsert({
    id: 'fixture',
    name: 'Synthetic',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: ['text'],
    capabilities: ['chat'],
    secretRef,
    enabled: true,
  })
  const mcp = {
    allTools: () => [
      {
        serverId: 'fixture',
        toolName: 'write',
        spec: {
          description: 'Synthetic MCP write',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
    ],
    async callTool() {
      ++toolsExecuted
      return { content: 'synthetic mutation performed', isError: false }
    },
  }
  const agent = new ChatAgent(store, (event) => events.push(event), null, mcp)
  const service = new WorkflowService({
    store,
    executor: new AgentWorkflowExecutor(store, agent, (event) =>
      events.push(event),
    ),
    availableTools: (id) => agent.workflow.tools(id),
    validateResources: async () => {},
    notify: (event) => events.push(event),
    clearPermissionDomain: (id) => agent.approvals.clearSession(id),
  })
  const definition = workflowFixture()
  for (const node of definition.nodes)
    node.role.policy.allowedTools = mode === 'approval' ? ['fixture/write'] : []
  const version = saveWorkflowDefinition(store, {
    projectId: project.id,
    baseRevision: 0,
    definition,
    origin: 'manual',
  })
  t.after(async () => {
    await service.dispose()
    agent.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    store.close()
    deleteSecret(secretRef)
    rmSync(dir, { recursive: true, force: true })
  })
  const start = {
    requestId: randomUUID(),
    projectId: project.id,
    definitionId: version.definitionId,
    revision: 1,
    inputs: { text: { type: 'text', value: 'topic' } },
    defaultModel: { providerId: 'fixture', model: 'text' },
    permissionPreset: 'workspace-full',
    approvalOverride: 'ask-everything',
  }
  return {
    store,
    project,
    service,
    agent,
    bodies,
    events,
    start,
    counts: () => ({ requests, toolsExecuted }),
  }
}

test('real Agent loop produces atomic checkpoints and isolated downstream input', async (t) => {
  const h = await fixture(t, 'valid')
  const started = await h.service.start(h.start)
  const result = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'succeeded' ? detail : null
  })
  assert.equal(result.attempts.length, 2)
  assert.equal(h.counts().requests, 2)
  for (const attempt of result.attempts) {
    assert.equal(h.store.runs.get(attempt.agentRunId).status, 'completed')
    assert.equal(h.store.runs.get(attempt.agentRunId).usage.promptTokens, 5)
    assert.ok(h.store.workflowAttempts.result(attempt.id).values)
    assert.equal(h.store.sessions.list(h.project.id).length, 0)
  }
  assert.ok(h.bodies[0].messages[0].content.includes('Output ports:'))
  assert.ok(!h.bodies[0].messages[0].content.includes('AGENTS.md'))
  assert.equal(
    h.bodies[1].messages.some(
      (message) =>
        message.role === 'user' && message.content.includes('verified result'),
    ),
    true,
  )
  await assert.rejects(
    async () =>
      h.agent.send({
        requestId: randomUUID(),
        sessionId: result.attempts[0].sessionId,
        content: 'bypass workflow',
      }),
    /Workflow/,
  )
})

test('invalid model result is a durable validation failure, not a silent retry', async (t) => {
  const h = await fixture(t, 'invalid')
  const started = await h.service.start(h.start)
  const result = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'failed' ? detail : null
  })
  assert.equal(result.run.errorCode, 'output_validation_failed')
  assert.equal(result.outputs.length, 0)
  assert.equal(h.counts().requests, 1)
  assert.equal(
    h.store.workflowAttempts.result(result.attempts[0].id).errorCode,
    'output_validation_failed',
  )
})

test('ask-everything applies to every node and approval exposes actual Workflow identity', async (t) => {
  const h = await fixture(t, 'approval')
  const started = await h.service.start(h.start)
  for (let i = 0; i < 2; i++) {
    const event = await until(
      () => h.events.filter((event) => event.type === 'approval.required')[i],
    )
    assert.equal(event.context.agent.workflowRunId, started.run.id)
    assert.ok(event.context.agent.workflowNodeId)
    const choice =
      event.choices.find((choice) => choice.label.includes('本会话')) ??
      event.choices.find((choice) => choice.id !== 'deny')
    // First node grants a reusable rule. The second still asks due to ask-everything.
    assert.ok(choice)
    assert.equal(
      h.agent.approvals.resolveChoice(event.toolCallId, choice.id),
      true,
    )
  }
  const result = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'succeeded' ? detail : null
  })
  assert.equal(h.counts().toolsExecuted, 2)
  assert.equal(result.run.toolsUsed, 2)
  assert.ok(
    result.attempts.every((attempt) => attempt.effectStatus === 'possible'),
  )
})

test('missing provider usage is marked estimated and still enforces node budgets', async (t) => {
  const h = await fixture(t, 'no-usage')
  const started = await h.service.start(h.start)
  const result = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'failed' ? detail : null
  })
  assert.equal(result.run.tokensEstimated, true)
  assert.equal(result.run.errorCode, 'run_token_budget')
  assert.ok(result.run.tokensUsed > 1000)
  assert.equal(h.counts().requests, 1)
})

test('Run completion and checkpoint commit together when the first finalization transaction fails', async (t) => {
  const h = await fixture(t, 'valid')
  const original = h.store.workflowAttempts.stageResult.bind(
    h.store.workflowAttempts,
  )
  let injected = false
  h.store.workflowAttempts.stageResult = (value) => {
    original(value)
    if (!injected) {
      injected = true
      throw new Error('synthetic_transaction_failure')
    }
  }
  const started = await h.service.start(h.start)
  const result = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'succeeded' ? detail : null
  })
  assert.equal(injected, true)
  assert.equal(h.counts().requests, 2)
  assert.equal(result.outputs.length, 2)
  assert.ok(
    result.attempts.every(
      (attempt) => h.store.workflowAttempts.result(attempt.id).values !== null,
    ),
  )
})

test('cancelling a pending model request conservatively accounts for unknown usage', async (t) => {
  const h = await fixture(t, 'pending')
  const started = await h.service.start(h.start)
  await until(() => h.counts().requests === 1)
  const result = await h.service.cancel(h.project.id, started.run.id)
  assert.equal(result.run.status, 'cancelled')
  assert.equal(result.run.tokensEstimated, true)
  assert.equal(result.run.tokensUsed, 1000)
  assert.equal(result.outputs.length, 0)
})
