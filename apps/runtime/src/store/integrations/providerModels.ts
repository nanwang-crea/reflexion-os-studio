import type { DatabaseSync } from 'node:sqlite'
import type {
  ProviderModel,
  ReasoningEffort,
} from '@reflexion-os-studio/contracts'
import { ReasoningEffortSchema } from '@reflexion-os-studio/contracts'
import { readProviderNumber } from './provider-values.js'
import { nowIso, type Row } from '../shared.js'

/** Provider 下的模型级配置；null 字段表示继承 Provider 默认。 */
export class ProviderModelStore {
  constructor(private readonly db: DatabaseSync) {}

  list(providerId: string): ProviderModel[] {
    return this.db
      .prepare(
        'SELECT * FROM provider_models WHERE provider_id = ? ORDER BY model ASC',
      )
      .all(providerId)
      .map((row) => this.toModel(row as Row))
  }

  get(providerId: string, model: string): ProviderModel | null {
    const row = this.db
      .prepare(
        'SELECT * FROM provider_models WHERE provider_id = ? AND model = ?',
      )
      .get(providerId, model)
    return row ? this.toModel(row as Row) : null
  }

  upsert(input: {
    providerId: string
    model: string
    temperature?: number | null
    maxTokens?: number | null
    contextWindow?: number | null
    contextBudget?: number | null
    reasoningEffort?: ReasoningEffort | null
    reasoningEffortSupported?: boolean
  }): ProviderModel {
    const existing = this.get(input.providerId, input.model)
    const updatedAt = nowIso()
    this.db
      .prepare(
        `INSERT INTO provider_models
          (provider_id, model, temperature, max_tokens, context_window, context_budget,
           reasoning_effort, reasoning_effort_supported, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model) DO UPDATE SET
           temperature = excluded.temperature,
           max_tokens = excluded.max_tokens,
           context_window = excluded.context_window,
           context_budget = excluded.context_budget,
           reasoning_effort = excluded.reasoning_effort,
           reasoning_effort_supported = excluded.reasoning_effort_supported,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.providerId,
        input.model,
        input.temperature === undefined
          ? (existing?.temperature ?? null)
          : input.temperature,
        input.maxTokens === undefined
          ? (existing?.maxTokens ?? null)
          : input.maxTokens,
        input.contextWindow === undefined
          ? (existing?.contextWindow ?? null)
          : input.contextWindow,
        input.contextBudget === undefined
          ? (existing?.contextBudget ?? null)
          : input.contextBudget,
        input.reasoningEffort === undefined
          ? (existing?.reasoningEffort ?? null)
          : input.reasoningEffort,
        input.reasoningEffortSupported === undefined
          ? existing?.reasoningEffortSupported
            ? 1
            : 0
          : input.reasoningEffortSupported
            ? 1
            : 0,
        updatedAt,
      )
    const row = this.db
      .prepare(
        'SELECT * FROM provider_models WHERE provider_id = ? AND model = ?',
      )
      .get(input.providerId, input.model)
    if (!row) throw new Error('provider model not found after upsert')
    return this.toModel(row as Row)
  }

  delete(providerId: string, model: string): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM provider_models WHERE provider_id = ? AND model = ?',
      )
      .run(providerId, model)
    return Number(result.changes) > 0
  }

  private toModel(row: Row): ProviderModel {
    return {
      providerId: String(row.provider_id),
      model: String(row.model),
      temperature: readProviderNumber('temperature', row.temperature),
      maxTokens: readProviderNumber('maxTokens', row.max_tokens),
      contextWindow: readProviderNumber('contextWindow', row.context_window),
      contextBudget: readProviderNumber('contextBudget', row.context_budget),
      reasoningEffort: this.parseReasoningEffort(row.reasoning_effort),
      reasoningEffortSupported: Number(row.reasoning_effort_supported) === 1,
      updatedAt: String(row.updated_at),
    }
  }

  private parseReasoningEffort(value: unknown): ReasoningEffort | null {
    const result = ReasoningEffortSchema.safeParse(value)
    return result.success ? result.data : null
  }
}
