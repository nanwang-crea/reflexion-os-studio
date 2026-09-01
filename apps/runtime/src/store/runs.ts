import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Run, RunStatus, Usage } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** Run 领域：一次回复的执行生命周期。 */
export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  listBySession(sessionId: string): Run[] {
    // 理由同 messages：同毫秒 Run 依赖随机 UUID 排序不稳定，rowid 即插入顺序。
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC',
      )
      .all(sessionId)
      .map((row) => this.toRun(row as Row))
  }

  create(input: {
    sessionId: string
    providerId: string | null
    model: string | null
    retryOfRunId?: string | null
    agentId?: string | null
    parentRunId?: string | null
    delegationId?: string | null
    skillId?: string | null
    planId?: string | null
    planStepId?: string | null
  }): Run {
    const run: Run = {
      id: randomUUID(),
      sessionId: input.sessionId,
      status: 'running',
      providerId: input.providerId,
      model: input.model,
      startedAt: nowIso(),
      completedAt: null,
      errorCode: null,
      retryOfRunId: input.retryOfRunId ?? null,
      agentId: input.agentId ?? null,
      parentRunId: input.parentRunId ?? null,
      delegationId: input.delegationId ?? null,
      skillId: input.skillId ?? null,
      planId: input.planId ?? null,
      planStepId: input.planStepId ?? null,
      usage: null,
    }
    this.db
      .prepare(
        'INSERT INTO runs (id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id, agent_id, parent_run_id, delegation_id, skill_id, plan_id, plan_step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.sessionId,
        run.status,
        run.providerId,
        run.model,
        run.startedAt,
        run.completedAt,
        run.errorCode,
        run.retryOfRunId,
        run.agentId,
        run.parentRunId,
        run.delegationId,
        run.skillId,
        run.planId,
        run.planStepId,
      )
    return run
  }

  attachPlan(id: string, planId: string, planStepId: string): void {
    this.db
      .prepare('UPDATE runs SET plan_id = ?, plan_step_id = ? WHERE id = ?')
      .run(planId, planStepId, id)
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? this.toRun(row as Row) : null
  }

  finalize(id: string, status: RunStatus, errorCode?: string): void {
    this.db
      .prepare(
        'UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?',
      )
      .run(status, nowIso(), errorCode ?? null, id)
  }

  /** 非终态推进：running ↔ awaiting_approval（工具审批等待）；终态一律走 finalize。 */
  setIntermediateStatus(
    id: string,
    status: 'running' | 'awaiting_approval',
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET status = ? WHERE id = ? AND status IN ('running', 'awaiting_approval')",
      )
      .run(status, id)
  }

  /** 累加模型调用的 token 用量（各模型轮次汇总）。 */
  addUsage(id: string, usage: Usage): void {
    const current = this.get(id)?.usage
    const promptTokens = (current?.promptTokens ?? 0) + usage.promptTokens
    const completionTokens =
      (current?.completionTokens ?? 0) + usage.completionTokens
    this.db
      .prepare('UPDATE runs SET usage_json = ? WHERE id = ?')
      .run(JSON.stringify({ promptTokens, completionTokens }), id)
  }

  activeForSession(sessionId: string): Run | null {
    const row = this.db
      .prepare(
        // awaiting_approval 同属进行中：审批等待期间不允许并发发送新消息。
        "SELECT * FROM runs WHERE session_id = ? AND status IN ('created', 'running', 'awaiting_approval') LIMIT 1",
      )
      .get(sessionId)
    return row ? this.toRun(row as Row) : null
  }

  /** 启动恢复：未结束的 Run 标记为 interrupted；等待审批的 Run 不自动放行。 */
  recoverInterrupted(): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', completed_at = ?
         WHERE status IN ('created', 'running', 'awaiting_approval')`,
      )
      .run(nowIso())
  }

  private toRun(row: Row): Run {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      status: String(row.status) as RunStatus,
      providerId: row.provider_id == null ? null : String(row.provider_id),
      model: row.model == null ? null : String(row.model),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      errorCode: row.error_code == null ? null : String(row.error_code),
      retryOfRunId:
        row.retry_of_run_id == null ? null : String(row.retry_of_run_id),
      agentId: row.agent_id == null ? null : String(row.agent_id),
      parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
      delegationId:
        row.delegation_id == null ? null : String(row.delegation_id),
      skillId: row.skill_id == null ? null : String(row.skill_id),
      planId: row.plan_id == null ? null : String(row.plan_id),
      planStepId: row.plan_step_id == null ? null : String(row.plan_step_id),
      usage: parseUsage(row.usage_json),
    }
  }
}

function parseUsage(value: unknown): Usage | null {
  if (value == null) return null
  try {
    const parsed = JSON.parse(String(value)) as {
      promptTokens?: unknown
      completionTokens?: unknown
    }
    if (
      typeof parsed.promptTokens === 'number' &&
      typeof parsed.completionTokens === 'number'
    ) {
      return {
        promptTokens: parsed.promptTokens,
        completionTokens: parsed.completionTokens,
      }
    }
  } catch {
    // 非法数据按未记录处理。
  }
  return null
}
