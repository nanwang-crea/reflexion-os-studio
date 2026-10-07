import { writePlanDocument } from '../dist/agent/tools/plan-documents.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from '../dist/agent/tools/plan-mode.js'

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-plan-mode-')))
  const session = store.sessions.create(null, 'plan')
  const requests = []
  const context = {
    store,
    sessionId: session.id,
    runId: 'run-1',
    messageId: 'message-1',
    emitter: {},
    system: null,
    workspaceRoot: null,
    projectId: null,
    interactions: {
      requestQuestions: async (request) => {
        requests.push(request)
        return [
          {
            questionId: 'plan-decision',
            selectedOptionIds: ['approve'],
          },
        ]
      },
    },
  }
  return { store, session, context, requests }
}

test('enter_plan_mode persists read-only mode idempotently', async () => {
  const { store, session, context } = setup()
  const tool = createEnterPlanModeTool(context)
  const first = await tool.execute({
    args: {},
    toolCallId: 'enter-1',
    signal: new AbortController().signal,
  })
  assert.equal(first.isError, false)
  assert.equal(store.sessions.get(session.id).executionMode, 'plan')
  const second = await tool.execute({
    args: {},
    toolCallId: 'enter-2',
    signal: new AbortController().signal,
  })
  assert.equal(second.data.previousMode, 'plan')
  store.close()
})

test('exit_plan_mode requires an active plan and exits only after approval', async () => {
  const { store, session, context, requests } = setup()
  store.sessions.setExecutionMode(session.id, 'plan')
  const plan = store.plans.create({
    sessionId: session.id,
    goal: '实现计划模式',
    steps: [{ id: 'plan-mode-1', title: '实现' }],
  })
  await writePlanDocument(context, plan, '# 实施方案\n\n完成实现并验证。')
  const tool = createExitPlanModeTool(context)
  const result = await tool.execute({
    args: { planId: plan.id },
    toolCallId: 'exit-1',
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.equal(result.data.approved, true)
  assert.equal(store.sessions.get(session.id).executionMode, 'execute')
  assert.equal(requests[0].kind, 'plan_approval')
  assert.equal(requests[0].toolCallId, 'exit-1')
  store.close()
})
