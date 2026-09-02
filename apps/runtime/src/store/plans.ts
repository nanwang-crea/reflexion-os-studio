import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Plan,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

export class PlanStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    sessionId: string
    messageId?: string | null
    goal: string
    steps: Array<{ id: string; title: string }>
  }): Plan {
    if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
      throw new Error('duplicate step id')
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
      if (active) throw new Error('session already has an active plan')
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
    if (!current) throw new Error('plan step not found')
    const previous = String(current.status) as PlanStepStatus
    if (previous === 'completed' || previous === 'cancelled')
      throw new Error(`cannot reopen ${previous} step`)
    const allowed: Record<PlanStepStatus, PlanStepStatus[]> = {
      pending: ['in_progress', 'skipped', 'cancelled'],
      in_progress: ['completed', 'failed', 'skipped', 'cancelled'],
      completed: [],
      failed: ['in_progress'],
      skipped: [],
      cancelled: [],
    }
    if (!allowed[previous].includes(status) && previous !== status)
      throw new Error(`invalid plan step transition: ${previous} -> ${status}`)
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

  complete(planId: string, summary: string): Plan {
    const plan = this.get(planId)
    if (!plan) throw new Error('plan not found')
    if (
      plan.steps.some(
        (step) => step.status === 'pending' || step.status === 'in_progress',
      )
    )
      throw new Error('plan has unfinished steps')
    const now = nowIso()
    this.db
      .prepare(
        "UPDATE plans SET status = 'completed', summary = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(summary, now, now, planId)
    return this.get(planId)!
  }

  fail(planId: string, summary: string): Plan {
    return this.finish(planId, 'failed', summary)
  }

  cancel(planId: string, summary: string): Plan {
    return this.finish(planId, 'cancelled', summary)
  }

  private finish(planId: string, status: PlanStatus, summary: string): Plan {
    const plan = this.get(planId)
    if (!plan) throw new Error('plan not found')
    if (plan.status !== 'active') throw new Error('plan is already terminal')
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
