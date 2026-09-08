import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Plan,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/**
 * 计划领域状态机错误：携带稳定错误码供模型自纠。
 * 码值约定见 docs/UPDATE-PLAN-TOOL-REDESIGN.md 第 3 节。
 */
export class PlanError extends Error {
  constructor(
    readonly code:
      | 'PLAN_ALREADY_EXISTS'
      | 'STEP_ID_CONFLICT'
      | 'INVALID_STEP_TRANSITION'
      | 'PLAN_NOT_READY_TO_COMPLETE'
      | 'PLAN_NOT_FOUND'
      | 'STEP_NOT_FOUND'
      | 'PLAN_TERMINAL',
    message: string,
  ) {
    super(message)
    this.name = 'PlanError'
  }
}

/** plan_steps.id 在全局唯一，跨计划冲突（模型自带 id）以 SQLite UNIQUE 约束暴露。 */
const SQLITE_UNIQUE_RE = /UNIQUE constraint failed/i

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message !== undefined &&
    SQLITE_UNIQUE_RE.test(error.message)
  )
}

export class PlanStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    sessionId: string
    messageId?: string | null
    goal: string
    steps: Array<{ id: string; title: string }>
  }): Plan {
    if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
      throw new PlanError('STEP_ID_CONFLICT', '计划内存在重复的步骤 id')
    const now = nowIso()
    const plan: Plan = {
      id: randomUUID(),
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      goal: input.goal,
      status: 'active',
      summary: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      steps: input.steps.map((step) => ({
        id: step.id,
        planId: '',
        title: step.title,
        status: 'pending',
        note: null,
        createdAt: now,
        updatedAt: now,
      })),
    }
    plan.steps = plan.steps.map((step) => ({ ...step, planId: plan.id }))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const active = this.db
        .prepare(
          "SELECT id FROM plans WHERE session_id = ? AND status = 'active' LIMIT 1",
        )
        .get(input.sessionId)
      if (active)
        throw new PlanError(
          'PLAN_ALREADY_EXISTS',
          '当前会话已存在活动计划；请沿用已有 planId 使用 update_step，或先 complete/fail/cancel 已有计划',
        )
      this.db
        .prepare(
          'INSERT INTO plans (id, session_id, message_id, goal, status, summary, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          plan.id,
          plan.sessionId,
          plan.messageId,
          plan.goal,
          plan.status,
          null,
          now,
          now,
          null,
        )
      const insert = this.db.prepare(
        'INSERT INTO plan_steps (id, plan_id, title, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const step of plan.steps)
        insert.run(step.id, plan.id, step.title, step.status, null, now, now)
      this.db.exec('COMMIT')
      return plan
    } catch (error) {
      this.db.exec('ROLLBACK')
      if (isUniqueViolation(error)) {
        throw new PlanError(
          'STEP_ID_CONFLICT',
          `步骤 id 与历史计划冲突（plan_steps.id 全局唯一）：${input.steps.map((step) => step.id).join(', ')}；请使用带唯一前缀的步骤 id`,
        )
      }
      throw error
    }
  }

  /** 启动恢复：进程退出时 active 计划及其未完成步骤统一失败收敛。 */
  recoverActive(): void {
    const now = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          "UPDATE plan_steps SET status = 'failed', note = ?, updated_at = ? WHERE status IN ('pending', 'in_progress') AND plan_id IN (SELECT id FROM plans WHERE status = 'active')",
        )
        .run('Runtime restarted before plan completion', now)
      this.db
        .prepare(
          "UPDATE plans SET status = 'failed', summary = ?, updated_at = ?, completed_at = ? WHERE status = 'active'",
        )
        .run('Runtime restarted before plan completion', now, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(id: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as
      Row | undefined
    if (!row) return null
    const steps = this.db
      .prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY rowid ASC')
      .all(id)
      .map((item) => this.toStep(item as Row))
    return this.toPlan(row, steps)
  }

  listBySession(sessionId: string): Plan[] {
    return this.db
      .prepare(
        'SELECT * FROM plans WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId)
      .map((row) => this.get(String((row as Row).id))!)
      .filter(Boolean)
  }

  updateStep(
    planId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string | null,
  ): PlanStep {
    const current = this.db
      .prepare('SELECT * FROM plan_steps WHERE id = ? AND plan_id = ?')
      .get(stepId, planId) as Row | undefined
    if (!current)
      throw new PlanError(
        'STEP_NOT_FOUND',
        `计划 ${planId} 中不存在步骤 ${stepId}`,
      )
    const previous = String(current.status) as PlanStepStatus
    // 终止状态（completed/failed/skipped/cancelled）不可回退、不可再次推进。
    const allowed: Record<PlanStepStatus, PlanStepStatus[]> = {
      pending: ['in_progress', 'failed', 'skipped', 'cancelled'],
      in_progress: ['completed', 'failed', 'skipped', 'cancelled'],
      completed: [],
      failed: [],
      skipped: [],
      cancelled: [],
    }
    if (previous !== status && !allowed[previous].includes(status))
      throw new PlanError(
        'INVALID_STEP_TRANSITION',
        `非法步骤流转：${previous} -> ${status}（终止状态不可回退；正常路径为 pending → in_progress → completed）`,
      )
    const now = nowIso()
    this.db
      .prepare(
        'UPDATE plan_steps SET status = ?, note = ?, updated_at = ? WHERE id = ? AND plan_id = ?',
      )
      .run(status, note ?? null, now, stepId, planId)
    this.db
      .prepare('UPDATE plans SET updated_at = ? WHERE id = ?')
      .run(now, planId)
    return this.toStep({
      ...current,
      status,
      note: note ?? null,
      updated_at: now,
    } as Row)
  }

  complete(planId: string, summary: string | null): Plan {
    const plan = this.get(planId)
    if (!plan) throw new PlanError('PLAN_NOT_FOUND', `计划不存在：${planId}`)
    if (
      plan.steps.some(
        (step) => step.status === 'pending' || step.status === 'in_progress',
      )
    )
      throw new PlanError(
        'PLAN_NOT_READY_TO_COMPLETE',
        '计划仍有未处理步骤（pending/in_progress），不得 complete_plan；请先推进或跳过全部步骤',
      )
    const now = nowIso()
    this.db
      .prepare(
        "UPDATE plans SET status = 'completed', summary = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(summary, now, now, planId)
    return this.get(planId)!
  }

  fail(planId: string, summary: string | null): Plan {
    return this.finish(planId, 'failed', summary)
  }

  cancel(planId: string, summary: string | null): Plan {
    return this.finish(planId, 'cancelled', summary)
  }

  /**
   * 把 Plan 的未完成步骤（pending/in_progress）收敛为 failed。
   * 供 Run Finalizer 失败收敛使用；只改步骤不改 Plan 本身状态。
   */
  failPendingSteps(planId: string): void {
    this.db
      .prepare(
        "UPDATE plan_steps SET status = 'failed', note = ?, updated_at = ? WHERE plan_id = ? AND status IN ('pending', 'in_progress')",
      )
      .run('Run 终止时该步骤未完成', nowIso(), planId)
  }

  private finish(
    planId: string,
    status: PlanStatus,
    summary: string | null,
  ): Plan {
    const plan = this.get(planId)
    if (!plan) throw new PlanError('PLAN_NOT_FOUND', `计划不存在：${planId}`)
    if (plan.status !== 'active')
      throw new PlanError('PLAN_TERMINAL', `计划已处于终止状态：${plan.status}`)
    const now = nowIso()
    this.db
      .prepare(
        'UPDATE plans SET status = ?, summary = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      )
      .run(status, summary, now, now, planId)
    return this.get(planId)!
  }

  private toStep(row: Row): PlanStep {
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      title: String(row.title),
      status: String(row.status) as PlanStepStatus,
      note: row.note == null ? null : String(row.note),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
  private toPlan(row: Row, steps: PlanStep[]): Plan {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: row.message_id == null ? null : String(row.message_id),
      goal: String(row.goal),
      status: String(row.status) as PlanStatus,
      summary: row.summary == null ? null : String(row.summary),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      steps,
    }
  }
}
