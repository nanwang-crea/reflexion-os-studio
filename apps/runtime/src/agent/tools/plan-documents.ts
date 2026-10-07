import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  PlanSnapshotSchema,
  PlanDocumentReadResultSchema,
  PlanDocumentWriteResultSchema,
  PlanDocumentCleanupResultSchema,
  type Plan,
  type PlanSnapshot,
  type PlanDocument,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { SystemRuntimeClient } from '../../system.js'
import type { ToolContext } from './shared.js'

export function planSpecification(plan: Plan): string {
  return JSON.stringify({
    goal: plan.goal,
    steps: plan.steps.map(({ id, title }) => ({ id, title })),
  })
}
const digest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

function location(store: Store, document: PlanDocument): string | null {
  const id = document.snapshot.projectId
  return id ? (store.projects.get(id)?.folderPath ?? null) : null
}

export async function writePlanDocument(
  ctx: ToolContext,
  plan: Plan,
  markdown: string,
  expectedSha256?: string,
): Promise<PlanSnapshot> {
  const previous = ctx.store.planDocuments.get(plan.id)
  const path = ctx.workspaceRoot
    ? posix.join('.reflexion-studio', 'plans', `${plan.id}.md`)
    : null
  const snapshot = PlanSnapshotSchema.parse({
    planId: plan.id,
    goal: plan.goal,
    markdown,
    sha256: digest(markdown),
    path,
    projectId: ctx.projectId ?? null,
    specification: planSpecification(plan),
  })
  if (path !== null) {
    if (!ctx.system?.available)
      throw new Error('系统工具未就绪，不能生成计划文件')
    const saved = PlanDocumentWriteResultSchema.parse(
      await ctx.system.request('plan.document', {
        workspaceRoot: ctx.workspaceRoot,
        planId: plan.id,
        action: 'write',
        content: markdown,
        ...(previous && previous.state !== 'deleted'
          ? { expectedSha256: expectedSha256 ?? previous.snapshot.sha256 }
          : {}),
      }),
    )
    if (saved.sha256 !== snapshot.sha256)
      throw new Error('计划文件摘要校验失败')
  }
  ctx.store.planDocuments.save({
    snapshot,
    retained: previous?.retained ?? false,
    state: 'active',
  })
  return snapshot
}

/** 提交时读取用户编辑后的全文，保存不可变审批快照。 */
export async function reviewPlanDocument(
  store: Store,
  system: SystemRuntimeClient | null,
  plan: Plan,
): Promise<PlanSnapshot> {
  const document = store.planDocuments.get(plan.id)
  if (!document || document.state === 'deleted')
    throw new Error(
      '请先用 manage_plan 的 write_document 提供完整 Markdown 方案',
    )
  let snapshot = {
    ...document.snapshot,
    goal: plan.goal,
    specification: planSpecification(plan),
  }
  const root = location(store, document)
  if (snapshot.path !== null) {
    if (!root || !system?.available)
      throw new Error('计划文件当前不可读取，请稍后重试')
    const result = PlanDocumentReadResultSchema.parse(
      await system.request('plan.document', {
        workspaceRoot: root,
        planId: plan.id,
        action: 'read',
      }),
    )
    if (!result.content?.trim() || !result.sha256)
      throw new Error('计划文件不存在或内容为空，请重新生成方案')
    snapshot = PlanSnapshotSchema.parse({
      ...snapshot,
      markdown: result.content,
      sha256: result.sha256,
    })
  }
  // 保持最后一次系统写入的 digest：人工编辑即使已审批，也不能被自动删除。
  return snapshot
}

export async function validatePlanSnapshot(
  store: Store,
  system: SystemRuntimeClient | null,
  sessionId: string,
  snapshot: PlanSnapshot,
): Promise<boolean> {
  const plan = store.plans.get(snapshot.planId)
  if (
    !plan ||
    plan.sessionId !== sessionId ||
    plan.status !== 'active' ||
    store.sessions.get(sessionId)?.executionMode !== 'plan' ||
    planSpecification(plan) !== snapshot.specification
  )
    return false
  const current = await reviewPlanDocument(store, system, plan)
  const latest = store.plans.get(snapshot.planId)
  return (
    latest !== null &&
    latest.status === 'active' &&
    planSpecification(latest) === snapshot.specification &&
    store.sessions.get(sessionId)?.executionMode === 'plan' &&
    current.sha256 === snapshot.sha256
  )
}

/** 终态文件的有界清理；失败持久化，下一次 sidecar ready 或计划工具调用时重试。 */
export async function cleanupPlanDocuments(
  store: Store,
  system: SystemRuntimeClient | null,
): Promise<void> {
  for (const document of store.planDocuments.listForCleanup()) {
    if (document.retained) {
      store.planDocuments.save({ ...document, state: 'preserved' })
      continue
    }
    if (document.snapshot.path === null) {
      store.planDocuments.save({ ...document, state: 'deleted' })
      continue
    }
    store.planDocuments.save({ ...document, state: 'cleanup_pending' })
    const root = location(store, document)
    if (!root || !system?.available) continue
    try {
      const result = PlanDocumentCleanupResultSchema.parse(
        await system.request('plan.document', {
          workspaceRoot: root,
          planId: document.snapshot.planId,
          action: 'delete',
          expectedSha256: document.snapshot.sha256,
        }),
      )
      store.planDocuments.save({ ...document, state: result.state })
    } catch {
      // 文件清理失败不改变任务结果；保留登记等待下一次重试。
    }
  }
}
