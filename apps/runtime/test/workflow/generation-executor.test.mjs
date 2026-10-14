import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { harness, until } from './harness.mjs'
import { ChatAgent } from '../../dist/agent/index.js'
import { generationModelExecutor } from '../../dist/workflow/generation/executor.js'
import { WorkflowGenerationService } from '../../dist/workflow/generation/service.js'
import { saveSecret, deleteSecret } from '../../dist/secrets.js'
import { requireSession } from '../../dist/agent/guards.js'

test('ordinary generation Runs disable all tools, use frozen sampling across repair and hide internal sessions', async (t) => {
  assert.ok(process.env.REFLEXION_DATA_DIR?.includes('reflexion-test-data-'))
  const h = harness(t),
    bodies = []
  const secretRef = saveSecret('synthetic-generation-key')
  const candidate = structuredClone(h.version.definition)
  for (const node of candidate.nodes) node.role.policy.allowedTools = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    bodies.push(JSON.parse(raw))
    const profile = h.store.providers.get('fixture')
    h.store.providers.upsert({ ...profile, temperature: 0.9 })
    const content =
      bodies.length === 1 ? 'invalid JSON' : JSON.stringify(candidate)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    )
    response.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    response.write(
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10}}\n\n',
    )
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  h.store.providers.upsert({
    ...h.store.providers.get('fixture'),
    secretRef,
    temperature: 0.1,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  })
  const agent = new ChatAgent(h.store, h.deps.notify, null, null)
  const service = new WorkflowGenerationService(
    h.store,
    generationModelExecutor(h.store, agent, h.deps.notify),
    (id) => agent.workflow.tools(id),
    h.deps.notify,
  )
  try {
    const draft = h.store.workflowDrafts.save({
      projectId: h.project.id,
      requestId: randomUUID(),
      baseRevision: 0,
      definitionId: null,
      baseVersion: 0,
      definition: candidate,
    })
    const initial = service.start({
      projectId: h.project.id,
      requestId: randomUUID(),
      draftId: draft.id,
      baseRevision: 1,
      mode: 'graph',
      description: 'Writer and editor',
      providerId: 'fixture',
      model: 'text',
    })
    const value = await until(() => {
      const current = service.get(h.project.id, initial.id)
      return current.status !== 'running' && current
    })
    assert.equal(value.status, 'ready')
    assert.equal(value.runIds.length, 2)
    assert.equal(value.tokensUsed, 40)
    assert.equal(value.tokensEstimated, false)
    assert.equal(bodies.length, 2)
    for (const body of bodies) {
      assert.ok(!body.tools || body.tools.length === 0)
      assert.equal(body.temperature, 0.1)
      assert.equal(body.messages[0].role, 'system')
      assert.ok(body.messages[0].content.includes('Do not execute'))
    }
    assert.equal(h.store.sessions.list(h.project.id).length, 0)
    assert.throws(() => requireSession(h.store, value.sessionId), /Workflow/)
    for (const id of value.runIds)
      assert.equal(h.store.runs.get(id).status, 'completed')
    assert.equal(h.store.workflowRuns.list(h.project.id).length, 0)
  } finally {
    await service.dispose()
    agent.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    deleteSecret(secretRef)
  }
})
