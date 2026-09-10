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
    'get',
    'create',
    'update_step',
    'modify_plan',
    'complete_plan',
    'cancel_plan',
  ])
  assert.deepEqual(schema.required, ['action'])
})

test('get action: read-only lookup of the active plan without context memory', async () => {
  const store = freshStore()
  const ctx = preparedCtx(store)
  const tool = createManagePlanTool(ctx)

  // 无活动计划时返回 null。
  const empty = await tool.execute({
    args: { action: 'get' },
    signal: new AbortController().signal,
  })
  assert.equal(empty.isError, false)
  assert.equal(JSON.parse(empty.content), null)

  const created = await tool.execute({
    args: {
      action: 'create',
      goal: '恢复现场',
      steps: [{ id: 'plan-get-1', title: '唯一步骤' }],
    },
    signal: new AbortController().signal,
  })
  assert.equal(created.isError, false)
  const plan = JSON.parse(created.content)

  // 省略 planId：返回当前会话的活动计划。
  const active = await tool.execute({
    args: { action: 'get' },
    signal: new AbortController().signal,
  })
  assert.equal(active.isError, false)
  const activePlan = JSON.parse(active.content)
  assert.equal(activePlan.id, plan.id)
  assert.equal(activePlan.status, 'active')
  assert.equal(activePlan.steps[0].id, 'plan-get-1')
  assert.equal(activePlan.steps[0].status, 'pending')

  // 显式 planId：返回该计划详情。
  const byId = await tool.execute({
    args: { action: 'get', planId: plan.id },
    signal: new AbortController().signal,
  })
  assert.equal(byId.isError, false)
  assert.equal(JSON.parse(byId.content).goal, '恢复现场')

  // 其他会话的计划不可读。
  const otherCtx = preparedCtx(store)
  const cross = await createManagePlanTool(otherCtx).execute({
    args: { action: 'get', planId: plan.id },
    signal: new AbortController().signal,
  })
  assert.equal(cross.isError, true)
  assert.equal(cross.code, 'invalid_request')

  // get 是只读的：不产生事件，活动计划不受影响。
  assert.deepEqual(ctx.emitter.events.map((event) => event.type), [
    'plan.created',
  ])
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
      error.code === 'PLAN_ALREADY_EXISTS' &&
      error.name === 'PlanError' &&
      // 错误消息回显活动计划详情（步骤 id 与状态），供模型在丢失上下文时自纠。
      error.message.includes('plan-a-1') &&
      error.message.includes('pending'),
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

test('store: modify merges steps in place (keep progress, insert pending, delete missing)', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const plan = store.plans.create({
    sessionId: session.id,
    goal: '原始目标',
    steps: [
      { id: 'plan-m-1', title: '第一步' },
      { id: 'plan-m-2', title: '第二步' },
      { id: 'plan-m-3', title: '第三步' },
    ],
  })
  store.plans.updateStep(plan.id, 'plan-m-1', 'in_progress')
  store.plans.updateStep(plan.id, 'plan-m-1', 'completed', '已完成')

  const modified = store.plans.modify(plan.id, {
    goal: '修订后的目标',
    steps: [
      // 同 id：保留 status/note，仅更新 title。
      { id: 'plan-m-1', title: '第一步（修订）' },
      // plan-m-2 未出现在新规格中：被删除。
      // plan-m-3 同 id 保留；plan-m-4 全新 id：插入为 pending。
      { id: 'plan-m-3', title: '第三步' },
      { id: 'plan-m-4', title: '新增步骤' },
    ],
  })

  assert.equal(modified.id, plan.id) // planId 不变
  assert.equal(modified.goal, '修订后的目标')
  assert.equal(modified.status, 'active')
  assert.deepEqual(
    modified.steps.map((step) => `${step.id}:${step.status}:${step.title}`),
    [
      'plan-m-1:completed:第一步（修订）',
      'plan-m-3:pending:第三步',
      'plan-m-4:pending:新增步骤',
    ],
  )
  assert.equal(modified.steps[0].note, '已完成') // 进度不丢

  // 被删除的步骤物理消失，其 id 可在未来计划中复用（plan_steps.id 全局主键）。
  const reused = store.sessions.create(null)
  const other = store.plans.create({
    sessionId: reused.id,
    goal: '复用已删除的步骤 id',
    steps: [{ id: 'plan-m-2', title: '复用' }],
  })
  assert.equal(other.steps[0].id, 'plan-m-2')
})

test('store: modify rejects terminal plans and duplicate step ids', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const plan = store.plans.create({
    sessionId: session.id,
    goal: 'terminal',
    steps: [{ id: 'plan-t-1', title: 'a' }],
  })
  store.plans.cancel(plan.id, null)
  assert.throws(
    () =>
      store.plans.modify(plan.id, {
        goal: 'x',
        steps: [{ id: 'plan-t-1', title: 'a' }],
      }),
    (error) => error.code === 'PLAN_TERMINAL',
  )

  const active = store.plans.create({
    sessionId: session.id,
    goal: 'active',
    steps: [{ id: 'plan-t-2', title: 'b' }],
  })
  assert.throws(
    () =>
      store.plans.modify(active.id, {
        goal: 'x',
        steps: [
          { id: 'plan-t-3', title: 'a' },
          { id: 'plan-t-3', title: 'b' },
        ],
      }),
    (error) => error.code === 'STEP_ID_CONFLICT',
  )
})

test('tool: modify_plan updates the active plan in place and emits plan.updated', async () => {
  const store = freshStore()
  const ctx = preparedCtx(store)
  const tool = createManagePlanTool(ctx)

  const created = await tool.execute({
    args: {
      action: 'create',
      goal: '初始目标',
      steps: [
        { id: 'plan-tool-1', title: '扫描' },
        { id: 'plan-tool-2', title: '实施' },
      ],
    },
    signal: new AbortController().signal,
  })
  assert.equal(created.isError, false)
  const plan = JSON.parse(created.content)
  await tool.execute({
    args: {
      action: 'update_step',
      planId: plan.id,
      stepId: 'plan-tool-1',
      status: 'in_progress',
    },
    signal: new AbortController().signal,
  })

  const modified = await tool.execute({
    args: {
      action: 'modify_plan',
      planId: plan.id,
      goal: '调整后的目标',
      steps: [
        { id: 'plan-tool-1', title: '扫描' },
        { id: 'plan-tool-3', title: '验证' },
      ],
    },
    signal: new AbortController().signal,
  })
  assert.equal(modified.isError, false)
  const updated = JSON.parse(modified.content)
  assert.equal(updated.id, plan.id)
  assert.equal(updated.goal, '调整后的目标')
  assert.deepEqual(
    updated.steps.map((step) => `${step.id}:${step.status}`),
    ['plan-tool-1:in_progress', 'plan-tool-3:pending'],
  )

  // 会话内活动计划仍是同一个（未取消重建）。
  const active = store.plans.getActive(ctx.sessionId)
  assert.equal(active?.id, plan.id)

  // 缺 planId 的错误消息必须可自纠：提示先 get 找回 planId。
  const missing = await tool.execute({
    args: { action: 'modify_plan', goal: 'x', steps: [{ id: 's', title: 't' }] },
    signal: new AbortController().signal,
  })
  assert.equal(missing.isError, true)
  assert.equal(missing.code, 'invalid_request')
  assert.ok(missing.content.includes('get'))

  const types = ctx.emitter.events.map((event) => event.type)
  assert.ok(types.includes('plan.updated'))
  assert.ok(!types.includes('plan.created') || types[0] === 'plan.created')
})

// 注：recoverActive 用例已移除——当前实现没有该方法，计划不随 Run 终态收敛
// （见 run-finalizer.ts 的既有设计），按"测试对齐当前实现"原则不保留该用例。
