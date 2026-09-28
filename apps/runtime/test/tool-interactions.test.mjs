import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { InteractionGateway } from '../dist/agent/interactions/index.js'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'
import { createAskUserTool } from '../dist/agent/tools/ask-user.js'
import { createExitPlanModeTool } from '../dist/agent/tools/plan-mode.js'
import { RunEventEmitter } from '../dist/events.js'
import { Store } from '../dist/store/index.js'

function setup() {
  const store = new Store(
    mkdtempSync(join(tmpdir(), 'reflexion-tool-interaction-')),
  )
  const session = store.sessions.create(null, 'interaction')
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const events = []
  const emitter = new RunEventEmitter(run.id, (event) => events.push(event))
  const interactions = new InteractionGateway(store)
  const registry = new ToolRegistry()
  const toolContext = {
    store,
    sessionId: session.id,
    messageId: 'message-id',
    runId: run.id,
    emitter,
    interactions,
    system: null,
    workspaceRoot: null,
    projectId: null,
    skills: {},
    mcp: null,
  }
  registry.register(createAskUserTool(toolContext))
  registry.register(createExitPlanModeTool(toolContext))
  return {
    store,
    session,
    run,
    events,
    interactions,
    execute(request) {
      return executeToolCall(
        {
          store,
          state: createRunExecutionState(),
          run,
          gate: new PermissionGate({
            preset: 'workspace-read',
            hasWorkspace: false,
            approvalOverride: 'default',
            dangerActive: () => false,
          }),
          approvals: new ApprovalGateway(),
          workspaceRoot: null,
          registry,
          emitter,
          sandboxProvider: null,
          permissionDomainId: run.id,
          rootRunId: run.id,
        },
        request,
        new AbortController().signal,
      )
    },
  }
}

async function waitForInteraction(context) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = context.events.find(
      (candidate) => candidate.type === 'interaction.required',
    )
    if (event) return event
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('interaction.required was not emitted')
}

test('ask_user persists the canonical tool call id and resumes execution', async () => {
  const context = setup()
  const protocolToolCallId = 'provider-ask-call'
  const execution = context.execute({
    id: protocolToolCallId,
    name: 'ask_user',
    arguments: JSON.stringify({
      questions: [
        {
          id: 'direction',
          header: '方向',
          question: '下一步做什么？',
          options: [
            { id: 'fix', label: '修复', description: '修复当前问题' },
            { id: 'stop', label: '停止', description: '暂时停止' },
          ],
        },
      ],
    }),
  })

  const required = await waitForInteraction(context)
  assert.notEqual(required.toolCallId, protocolToolCallId)
  assert.equal(
    context.store.toolCalls.get(required.toolCallId).toolName,
    'ask_user',
  )
  assert.equal(
    context.interactions.listPending()[0].toolCallId,
    required.toolCallId,
  )
  assert.deepEqual(
    context.interactions.respond(required.interactionId, [
      { questionId: 'direction', selectedOptionIds: ['fix'] },
    ]),
    { accepted: true, recovered: null },
  )

  const result = await execution
  assert.equal(result.isError, false)
  assert.equal(
    context.store.toolCalls.get(required.toolCallId).status,
    'completed',
  )
  assert.equal(context.interactions.listPending().length, 0)
  context.store.close()
})

test('exit_plan_mode uses the same canonical interaction boundary', async () => {
  const context = setup()
  context.store.sessions.setExecutionMode(context.session.id, 'plan')
  const plan = context.store.plans.create({
    sessionId: context.session.id,
    goal: '修复交互边界',
    steps: [{ id: 'fix-boundary', title: '修复调用身份' }],
  })
  const protocolToolCallId = 'provider-exit-call'
  const execution = context.execute({
    id: protocolToolCallId,
    name: 'exit_plan_mode',
    arguments: JSON.stringify({ planId: plan.id }),
  })

  const required = await waitForInteraction(context)
  assert.equal(required.kind, 'plan_approval')
  assert.notEqual(required.toolCallId, protocolToolCallId)
  assert.equal(
    context.store.toolCalls.get(required.toolCallId).toolName,
    'exit_plan_mode',
  )
  context.interactions.respond(required.interactionId, [
    { questionId: 'plan-decision', selectedOptionIds: ['approve'] },
  ])

  const result = await execution
  assert.equal(result.isError, false)
  assert.equal(result.data.approved, true)
  assert.equal(
    context.store.sessions.get(context.session.id).executionMode,
    'execute',
  )
  context.store.close()
})
