import type { DatabaseSync } from 'node:sqlite'
import {
  AgentPolicySchema,
  type AgentDefinition,
  type AgentTemplate,
} from '@reflexion-os-studio/contracts'
import { randomUUID } from 'node:crypto'
import { nowIso, type Row } from '../shared.js'

export class AgentStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): AgentTemplate[] {
    return this.db
      .prepare('SELECT * FROM agents ORDER BY name, id')
      .all()
      .map((row) => this.toAgent(row as Row))
  }

  get(id: string): AgentTemplate | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      Row | undefined
    return row ? this.toAgent(row) : null
  }

  setEnabled(id: string, enabled: boolean): AgentTemplate | null {
    const changed = this.db
      .prepare('UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), id)
    return Number(changed.changes) === 0 ? null : this.get(id)
  }

  upsert(
    input: Pick<
      AgentDefinition,
      'id' | 'name' | 'description' | 'systemPrompt' | 'enabled'
    > & { policy?: AgentDefinition['policy'] },
  ): AgentTemplate {
    const now = nowIso()
    const policy = input.policy ?? this.get(input.id)?.policy ?? DEFAULT_POLICY
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, system_prompt, policy_json, source, builtin, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'builtin', 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
      system_prompt=excluded.system_prompt, policy_json=excluded.policy_json,
      enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        input.systemPrompt,
        JSON.stringify(policy),
        input.enabled ? 1 : 0,
        now,
        now,
      )
    return this.get(input.id)!
  }

  saveUser(input: {
    id?: string
    name: string
    description: string
    systemPrompt: string
    enabled: boolean
    allowedTools: string[]
    canDelegate: boolean
  }): AgentTemplate {
    const id = input.id ?? `template-${randomUUID()}`
    const current = this.get(id)
    if (current?.builtin) throw new Error('built-in template is immutable')
    const now = nowIso()
    const policy = {
      version: 1 as const,
      permissionCeiling: 'workspace-full' as const,
      allowedTools: [...new Set(input.allowedTools)],
      canDelegate: input.canDelegate,
    }
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, system_prompt, policy_json, source, builtin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'user', 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
       system_prompt=excluded.system_prompt, policy_json=excluded.policy_json,
       enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.description,
        input.systemPrompt,
        JSON.stringify(policy),
        input.enabled ? 1 : 0,
        current?.createdAt ?? now,
        now,
      )
    return this.get(id)!
  }

  removeUser(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM agents WHERE id = ? AND builtin = 0')
      .run(id)
    return Number(result.changes) > 0
  }

  private toAgent(row: Row): AgentTemplate {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      systemPrompt: String(row.system_prompt),
      policy: AgentPolicySchema.parse(JSON.parse(String(row.policy_json))),
      source: (row.source ?? 'builtin') as AgentTemplate['source'],
      builtin: Boolean(row.builtin ?? 1),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

const DEFAULT_POLICY: AgentDefinition['policy'] = {
  version: 1,
  permissionCeiling: 'workspace-read',
  allowedTools: [
    'get_current_time',
    'web.fetch',
    'skill.use',
    'file.read',
    'file.list',
    'file.glob',
    'file.grep',
  ],
  canDelegate: false,
}
