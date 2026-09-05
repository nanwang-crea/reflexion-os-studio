import type { DatabaseSync } from 'node:sqlite'
import type { AgentDefinition } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

export class AgentStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): AgentDefinition[] {
    return this.db
      .prepare('SELECT * FROM agents ORDER BY name, id')
      .all()
      .map((row) => this.toAgent(row as Row))
  }

  get(id: string): AgentDefinition | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      Row | undefined
    return row ? this.toAgent(row) : null
  }

  upsert(
    input: Pick<
      AgentDefinition,
      'id' | 'name' | 'description' | 'systemPrompt' | 'enabled'
    >,
  ): AgentDefinition {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, system_prompt, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      system_prompt=excluded.system_prompt, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        input.systemPrompt,
        input.enabled ? 1 : 0,
        now,
        now,
      )
    return this.get(input.id)!
  }

  private toAgent(row: Row): AgentDefinition {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      systemPrompt: String(row.system_prompt),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
