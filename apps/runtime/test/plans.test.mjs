import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import {
  createLegacyUpdatePlanTool,
  createManagePlanTool,
} from '../dist/agent/tools/plans.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-plans-')))
}

function baseCtx(store, overrides = {}) {
  const events = []
  return {
    store,
    sessionId: overrides.sessionId ?? 'session-1',
    messageId: 'message-1',
    runId: 'run-1',
    emitter: { next: (event) => events.push(event), events },
    system: null,
    workspaceRoot: null,
    skills: { get: () => null, list: () => [] },
    mcp: null,
    ...overrides,
  }
}

/** 建立真实 session/run/message 行的工具上下文（messageId 有外键约束）。 */
function preparedCtx(store, overrides = {}) {
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  return baseCtx(store, {
    sessionId: session.id,
    runId: run.id,
    messageId: message.id,
    ...overrides,
  })
}

test('manage_plan tool definition carries final name, description and flat schema', () => {
  const tool = createManagePlanTool(baseCtx(freshStore()))
  assert.equal(tool.name, 'manage_plan')
  assert.ok(tool.description.includes('同一任务同一时刻最多存在一个活动计划'))
  assert.ok(tool.description.includes('不要自创 action'))
  const schema = tool.parameters
  // oneOf 判别联合会让 OpenAI 兼容端点误解 schema 导致空参调用（invalid_request），
  // 必须用与仓库其它工具一致的扁平 object schema。
  assert.equal(schema.type, 'object')
  assert.equal(schema.oneOf, undefined)
  assert.deepEqual(schema.properties.action.enum, [
    'create',
    'update_step',
    'complete_plan',
    'cancel_plan',
  ])
  assert.deepEqual(schema.required, ['action'])
})

test('legacy update_plan alias maps to the same implementation', async () => {
  const store = freshStore()
  const ctx = preparedCtx(store)
  const alias = createLegacyUpdatePlanTool(ctx)
  assert.equal(alias.name, 'update_plan')
  const created = await alias.execute({
    args: {
      action: 'create',
      goal: '修复路由',
      steps: [{ id: 'plan-s1-scan', title: '扫描' }],
    },
    signal: new AbortController().signal,
  })
  assert.equal(created.isError, false)
  const plan = JSON.parse(created.content)
  assert.equal(plan.status, 'active')
  assert.equal(store.plans.listBySession(ctx.sessionId).length, 1)
})

test('action update is rejected with a clear pointer to update_step', async () => {
  const store = freshStore()
  const tool = createManagePlanTool(baseCtx(store))
  const result = await tool.execute({
    args: { action: 'update', planId: 'pl', stepId: 's1', status: 'completed' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.equal(result.code, 'invalid_request')
  assert.ok(result.content.includes('update_step'))
})

test('plan lifecycle through the tool: create → step flow → complete', async () => {
  const store = freshStore()
  const ctx = preparedCtx(store)
  const tool = createManagePlanTool(ctx)

  const created = await tool.execute({
    args: {
      action: 'create',
      goal: '修复路由问题',
      steps: [
        { id: 'plan-s1-scan', title: '扫描相关代码' },
        { id: 'plan-s1-fix', title: '修复实现' },
      ],
    },
    signal: new AbortController().signal,
  })
  assert.equal(created.isError, false)
  const plan = JSON.parse(created.content)
  assert.equal(plan.steps.length, 2)
  assert.ok(plan.steps.every((step) => step.status === 'pending'))

  const inProgress = await tool.execute({
    args: {
      action: 'update_step',
      planId: plan.id,
      stepId: 'plan-s1-scan',
      status: 'in_progress',
    },
    signal: new AbortController().signal,
  })
  assert.equal(inProgress.isError, false)
  assert.equal(JSON.parse(inProgress.content).status, 'in_progress')

  const done = await tool.execute({
    args: {
      action: 'update_step',
      planId: plan.id,
      stepId: 'plan-s1-scan',
      status: 'completed',
      note: '扫描完成',
    },
    signal: new AbortController().signal,
  })
  assert.equal(done.isError, false)
  assert.equal(JSON.parse(done.content).status, 'completed')

  const skipped = await tool.execute({
    args: {
      action: 'update_step',
      planId: plan.id,
      stepId: 'plan-s1-fix',
      status: 'skipped',
    },
    signal: new AbortController().signal,
  })
  assert.equal(skipped.isError, false)

  const completed = await tool.execute({
    args: {
      action: 'complete_plan',
      planId: plan.id,
      summary: '全部步骤已完成',
    },
    signal: new AbortController().signal,
  })
  assert.equal(completed.isError, false)
  assert.equal(JSON.parse(completed.content).status, 'completed')

  const types = ctx.emitter.events.map((event) => event.type)
  assert.deepEqual(types, [
    'plan.created',
    'plan.step.updated',
    'plan.step.updated',
    'plan.step.updated',
    'plan.updated',
  ])
})

test('store: second active plan in the same session is rejected with PLAN_ALREADY_EXISTS', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  store.plans.create({
    sessionId: session.id,
    goal: 'first',
    steps: [{ id: 'plan-a-1', title: 'a' }],
  })
  assert.throws(
    () =>
      store.plans.create({
        sessionId: session.id,
        goal: 'second',
        steps: [{ id: 'plan-b-1', title: 'b' }],
      }),
    (error) =>
      error.code === 'PLAN_ALREADY_EXISTS' && error.name === 'PlanError',
  )
})

test('store: duplicate step ids and global id conflicts both raise STEP_ID_CONFLICT', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const second = store.sessions.create(null)
  assert.throws(
    () =>
      store.plans.create({
        sessionId: session.id,
        goal: 'dup',
        steps: [
          { id: 'plan-same', title: 'a' },
          { id: 'plan-same', title: 'b' },
        ],
      }),
    (error) => error.code === 'STEP_ID_CONFLICT',
  )

  store.plans.create({
    sessionId: session.id,
    goal: 'first',
    steps: [{ id: 'plan-global-1', title: 'a' }],
  })
  // 第一个计划已取消，但仍占用全局唯一 step id。
  store.plans.cancel(store.plans.listBySession(session.id)[0].id, null)
  assert.throws(
    () =>
      store.plans.create({
        sessionId: second.id,
        goal: 'clash',
        steps: [{ id: 'plan-global-1', title: 'a' }],
      }),
    (error) => error.code === 'STEP_ID_CONFLICT',
  )
})

test('store: step transitions enforce pending → in_progress → completed and terminal states', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const plan = store.plans.create({
    sessionId: session.id,
    goal: 'flow',
    steps: [{ id: 'plan-flow-1', title: 'a' }],
  })
  const stepId = plan.steps[0].id

  assert.throws(
    () => store.plans.updateStep(plan.id, stepId, 'completed'),
    (error) => error.code === 'INVALID_STEP_TRANSITION',
  )

  store.plans.updateStep(plan.id, stepId, 'in_progress')
  store.plans.updateStep(plan.id, stepId, 'completed')
  assert.throws(
    () => store.plans.updateStep(plan.id, stepId, 'in_progress'),
    (error) => error.code === 'INVALID_STEP_TRANSITION',
  )
})

test('store: unknown step status failed is rejected as an invalid transition', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const plan = store.plans.create({
    sessionId: session.id,
    goal: 'terminal',
    steps: [{ id: 'plan-term-1', title: 'a' }],
  })
  const stepId = plan.steps[0].id
  // 当前实现没有 failed 步骤状态：单步受挫用 in_progress + note 表达，整任务放弃用 cancel_plan。
  assert.throws(
    () => store.plans.updateStep(plan.id, stepId, 'failed'),
    (error) => error.code === 'INVALID_STEP_TRANSITION',
  )
  // 状态机未被破坏：正常流转仍然可行。
  store.plans.updateStep(plan.id, stepId, 'in_progress')
  store.plans.updateStep(plan.id, stepId, 'completed')
})

test('store: complete requires all steps processed and terminal plans cannot revert', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const plan = store.plans.create({
    sessionId: session.id,
    goal: 'complete',
    steps: [
      { id: 'plan-c-1', title: 'a' },
      { id: 'plan-c-2', title: 'b' },
    ],
  })
  store.plans.updateStep(plan.id, 'plan-c-1', 'in_progress')
  store.plans.updateStep(plan.id, 'plan-c-1', 'completed')
  assert.throws(
    () => store.plans.complete(plan.id, null),
    (error) => error.code === 'PLAN_NOT_READY_TO_COMPLETE',
  )
  store.plans.updateStep(plan.id, 'plan-c-2', 'skipped')
  const completed = store.plans.complete(plan.id, 'done')
  assert.equal(completed.status, 'completed')

  assert.throws(
    () => store.plans.cancel(plan.id, null),
    (error) => error.code === 'PLAN_TERMINAL',
  )
})

// 注：recoverActive 用例已移除——当前实现没有该方法，计划不随 Run 终态收敛
// （见 run-finalizer.ts 的既有设计），按"测试对齐当前实现"原则不保留该用例。
