import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../dist/store/index.js'
import { SystemRuntimeClient } from '../dist/system.js'
import {
  writePlanDocument,
  reviewPlanDocument,
  cleanupPlanDocuments,
} from '../dist/agent/tools/plan-documents.js'
import {
  applyPlanApproval,
  createExitPlanModeTool,
} from '../dist/agent/tools/plan-mode.js'
import { createManagePlanTool } from '../dist/agent/tools/plans.js'
import { normalizeToolOutput } from '../dist/agent/run/toolResults.js'

const binary = resolve(
  '../../crates/target/debug',
  process.platform === 'win32'
    ? 'reflexion-system-runtime.exe'
    : 'reflexion-system-runtime',
)
const proposal =
  '# 实施方案\n\n目标：修复计划审阅。\n\n步骤：添加链接与快照。\n\n范围：计划工具与界面。\n\n验证：单测和构建。\n\n取舍：临时文档与历史快照分开。\n'
const approve = [
  { questionId: 'plan-decision', selectedOptionIds: ['approve'] },
]

function planContext(store, root = null, system = null) {
  const project = root
    ? store.projects.create({ name: 'plans', folderPath: root })
    : null
  const session = store.sessions.create(project?.id ?? null, 'plan')
  store.sessions.setExecutionMode(session.id, 'plan')
  const plan = store.plans.create({
    sessionId: session.id,
    goal: '审阅方案',
    steps: [{ id: `step-${session.id}`, title: '实现与验证' }],
  })
  return {
    store,
    system,
    session,
    plan,
    sessionId: session.id,
    workspaceRoot: root,
    projectId: project?.id ?? null,
    emitter: { next() {} },
  }
}
async function ready(client) {
  const deadline = Date.now() + 10_000
  while (!client.available && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.available, true, 'Rust sidecar must become ready')
}

test('approval requires a proposal and rejects changed plan specifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-plan-test-'))
  const store = new Store(dir)
  try {
    const ctx = planContext(store)
    const noDocument = await createExitPlanModeTool(ctx).execute({
      args: { planId: ctx.plan.id },
      signal: new AbortController().signal,
      toolCallId: 'exit',
    })
    assert.equal(noDocument.code, 'plan_document_required')
    const snapshot = await writePlanDocument(ctx, ctx.plan, proposal)
    store.plans.modify(ctx.plan.id, {
      goal: '改变范围',
      steps: [{ id: ctx.plan.steps[0].id, title: '其他任务' }],
    })
    const result = await applyPlanApproval(
      store,
      ctx.session.id,
      ctx.plan.id,
      approve,
      snapshot,
    )
    assert.equal(result.code, 'stale_plan')
    assert.equal(store.sessions.get(ctx.session.id).executionMode, 'plan')
    assert.equal(
      (await applyPlanApproval(store, ctx.session.id, ctx.plan.id, approve))
        .isError,
      true,
      'legacy approval without snapshot must fail closed',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'real Rust plan file lifecycle: review, stale approval, retention, cleanup and restart',
  { skip: !existsSync(binary) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflexion-plan-db-'))
    const root = mkdtempSync(join(tmpdir(), 'reflexion-plan-workspace-'))
    let store = new Store(dir)
    const system = new SystemRuntimeClient(binary, [], () => {})
    system.start()
    try {
      await ready(system)
      execFileSync('git', ['init', '-q', root])
      const ctx = planContext(store, root, system)
      const snapshot = await writePlanDocument(ctx, ctx.plan, proposal)
      const path = join(root, snapshot.path)
      assert.equal(readFileSync(path, 'utf8'), proposal)
      execFileSync('git', ['-C', root, 'check-ignore', snapshot.path])
      assert.equal(
        execFileSync('git', ['-C', root, 'status', '--porcelain'], {
          encoding: 'utf8',
        }),
        '',
      )
      const result = await applyPlanApproval(
        store,
        ctx.session.id,
        ctx.plan.id,
        approve,
        snapshot,
        system,
      )
      assert.equal(result.data.approved, true)
      assert.ok(
        result.content.includes(proposal),
        'approved document must be fed back to executing model',
      )
      assert.equal(existsSync(path), true, 'approval is not task completion')
      await cleanupPlanDocuments(store, system)
      assert.equal(
        existsSync(path),
        true,
        'active/interrupted tasks retain their document',
      )
      const run = store.runs.create({
        sessionId: ctx.session.id,
        providerId: 'provider',
        model: 'model',
      })
      const tool = store.toolCalls.create({
        runId: run.id,
        messageId: null,
        toolName: 'exit_plan_mode',
        args: { planId: ctx.plan.id },
      })
      store.toolCalls.finalize(
        tool.id,
        'completed',
        normalizeToolOutput(result, ctx.projectId, 'exit_plan_mode'),
      )
      store.plans.updateStep(ctx.plan.id, ctx.plan.steps[0].id, 'in_progress')
      store.plans.updateStep(ctx.plan.id, ctx.plan.steps[0].id, 'completed')
      store.plans.complete(ctx.plan.id, '完成')
      await cleanupPlanDocuments(store, null)
      assert.equal(
        store.planDocuments.get(ctx.plan.id).state,
        'cleanup_pending',
      )
      store.close()
      store = new Store(dir)
      assert.equal(
        store.planDocuments.get(ctx.plan.id).state,
        'cleanup_pending',
      )
      await cleanupPlanDocuments(store, system)
      assert.equal(existsSync(path), false)
      assert.equal(store.planDocuments.get(ctx.plan.id).state, 'deleted')
      assert.equal(
        store.toolCalls.get(tool.id).output.data.planSnapshot.markdown,
        proposal,
        'full historical snapshot survives file deletion and restart',
      )
      await cleanupPlanDocuments(store, system)

      const edited = planContext(store, root, system)
      const initial = await writePlanDocument(edited, edited.plan, proposal)
      const editedPath = join(root, initial.path)
      const userText = proposal + '\n用户补充：保留人工修改。\n'
      writeFileSync(editedPath, userText)
      assert.equal(
        (
          await applyPlanApproval(
            store,
            edited.session.id,
            edited.plan.id,
            approve,
            initial,
            system,
          )
        ).code,
        'stale_plan',
      )
      assert.equal(store.sessions.get(edited.session.id).executionMode, 'plan')
      await assert.rejects(() =>
        writePlanDocument(edited, edited.plan, '覆盖用户内容'),
      )
      const revised = await reviewPlanDocument(store, system, edited.plan)
      assert.equal(revised.markdown, userText)
      assert.equal(
        (
          await applyPlanApproval(
            store,
            edited.session.id,
            edited.plan.id,
            approve,
            revised,
            system,
          )
        ).data.approved,
        true,
      )
      store.plans.cancel(edited.plan.id, '取消')
      await cleanupPlanDocuments(store, system)
      assert.equal(store.planDocuments.get(edited.plan.id).state, 'preserved')
      assert.equal(readFileSync(editedPath, 'utf8'), userText)

      const kept = planContext(store, root, system)
      const keepSnapshot = await writePlanDocument(kept, kept.plan, proposal)
      await applyPlanApproval(
        store,
        kept.session.id,
        kept.plan.id,
        [{ ...approve[0], keepPlan: true }],
        keepSnapshot,
        system,
      )
      store.plans.cancel(kept.plan.id, '取消')
      await cleanupPlanDocuments(store, system)
      assert.equal(existsSync(join(root, keepSnapshot.path)), true)
      assert.equal(store.planDocuments.get(kept.plan.id).state, 'preserved')

      const cancelled = planContext(store, root, system)
      const cancelSnapshot = await writePlanDocument(
        cancelled,
        cancelled.plan,
        proposal,
      )
      await applyPlanApproval(
        store,
        cancelled.session.id,
        cancelled.plan.id,
        [{ questionId: 'plan-decision', selectedOptionIds: ['cancel'] }],
        cancelSnapshot,
        system,
      )
      assert.equal(existsSync(join(root, cancelSnapshot.path)), false)
      assert.equal(
        store.sessions.get(cancelled.session.id).executionMode,
        'plan',
      )

      const toolCtx = planContext(store, root, system)
      const doc = await writePlanDocument(toolCtx, toolCtx.plan, proposal)
      writeFileSync(join(root, doc.path), userText)
      const managed = createManagePlanTool(toolCtx)
      const read = await managed.execute({
        args: { action: 'get', planId: toolCtx.plan.id },
        signal: new AbortController().signal,
      })
      const current = JSON.parse(read.content).document
      const written = await managed.execute({
        args: {
          action: 'write_document',
          planId: toolCtx.plan.id,
          markdown: userText + '\n修订完成。',
          expectedSha256: current.sha256,
        },
        signal: new AbortController().signal,
      })
      assert.equal(
        written.isError,
        false,
        'explicit read digest permits intentional revision',
      )
    } finally {
      store.close()
      await system.shutdown()
      rmSync(dir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('pending approval stores exact document snapshot across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-plan-pending-'))
  let store = new Store(dir)
  try {
    const ctx = planContext(store)
    const snapshot = await writePlanDocument(ctx, ctx.plan, proposal)
    const run = store.runs.create({
      sessionId: ctx.session.id,
      providerId: 'provider',
      model: 'model',
    })
    store.runs.setIntermediateStatus(run.id, 'awaiting_user_input')
    const tool = store.toolCalls.create({
      runId: run.id,
      messageId: null,
      toolName: 'exit_plan_mode',
      args: { planId: ctx.plan.id },
      status: 'awaiting_user_input',
    })
    store.interactions.create({
      id: 'pending-plan',
      sessionId: ctx.session.id,
      runId: run.id,
      toolCallId: tool.id,
      kind: 'plan_approval',
      questions: [
        {
          id: 'plan-decision',
          header: '审批',
          question: '批准？',
          multiSelect: false,
          plan: snapshot,
          options: [
            { id: 'approve', label: '执行', description: '执行计划' },
            { id: 'revise', label: '修改', description: '继续计划' },
          ],
        },
      ],
    })
    store.close()
    store = new Store(dir)
    const recovered = store.interactions.get('pending-plan')
    assert.equal(recovered.status, 'pending')
    assert.deepEqual(recovered.questions[0].plan, snapshot)
    const result = await applyPlanApproval(
      store,
      ctx.session.id,
      ctx.plan.id,
      approve,
      recovered.questions[0].plan,
    )
    assert.equal(result.data.approved, true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
