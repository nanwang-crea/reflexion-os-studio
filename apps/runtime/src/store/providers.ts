import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ProviderCapabilitySchema,
  type ProviderCapability,
  type ProviderProfile,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** 模型供应商领域：多供应商 × 多模型配置。 */
export class ProviderStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): ProviderProfile[] {
    return this.db
      .prepare('SELECT * FROM provider_profiles ORDER BY updated_at DESC')
      .all()
      .map((row) => this.toProviderProfile(row as Row))
  }

  getEnabled(): ProviderProfile | null {
    const row = this.db
      .prepare(
        'SELECT * FROM provider_profiles WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1',
      )
      .get()
    return row ? this.toProviderProfile(row as Row) : null
  }

  get(id: string): ProviderProfile | null {
    const row = this.db
      .prepare('SELECT * FROM provider_profiles WHERE id = ?')
      .get(id)
    return row ? this.toProviderProfile(row as Row) : null
  }

  upsert(input: {
    id?: string
    name: string
    baseUrl: string
    models: string[]
    capabilities?: ProviderCapability[]
    secretRef: string
    enabled: boolean
  }): ProviderProfile {
    const id = input.id ?? randomUUID()
    // capabilities 省略时：编辑保留原值，新建缺省 ['chat']。
    let capabilities = input.capabilities
    if (capabilities === undefined) {
      capabilities = input.id
        ? (this.get(id)?.capabilities ?? ['chat'])
        : ['chat']
    }
    const updatedAt = nowIso()
    this.db
      .prepare(
        `INSERT INTO provider_profiles (id, name, base_url, models, capabilities, secret_ref, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           models = excluded.models,
           capabilities = excluded.capabilities,
           secret_ref = excluded.secret_ref,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.baseUrl,
        JSON.stringify(input.models),
        JSON.stringify(capabilities),
        input.secretRef,
        input.enabled ? 1 : 0,
        updatedAt,
      )
    const row = this.db
      .prepare('SELECT * FROM provider_profiles WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`provider profile not found after upsert: ${id}`)
    return this.toProviderProfile(row as Row)
  }

  /** 删除供应商配置；返回是否确实删除了行。 */
  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM provider_profiles WHERE id = ?')
      .run(id)
    return Number(result.changes) > 0
  }

  private toProviderProfile(row: Row): ProviderProfile {
    let models: string[] = []
    try {
      const parsed: unknown = JSON.parse(String(row.models ?? '[]'))
      if (Array.isArray(parsed)) {
        models = parsed
          .map((item) => String(item))
          .filter((item) => item !== '')
      }
    } catch {
      models = []
    }
    return {
      id: String(row.id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      models,
      capabilities: this.parseCapabilities(row.capabilities),
      secretRef: String(row.secret_ref),
      enabled: Number(row.enabled) === 1,
      updatedAt: String(row.updated_at),
    }
  }

  /** capabilities 解析；异常/缺失数据回退为 ['chat']，保证读取永远可校验。 */
  private parseCapabilities(value: unknown): ProviderCapability[] {
    try {
      const parsed: unknown = JSON.parse(String(value ?? '["chat"]'))
      const result = ProviderCapabilitySchema.array().safeParse(parsed)
      if (result.success) return result.data
    } catch {
      // 落入回退分支
    }
    return ['chat']
  }
}
