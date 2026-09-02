import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { McpServer } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** MCP server 配置文件(命令/参数/环境)与最后状态;工具清单在内存管理服务。 */
export class McpServerStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): McpServer[] {
    return this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY updated_at DESC')
      .all()
      .map((row) => this.toServer(row as Row))
  }

  get(id: string): McpServer | null {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id)
    return row ? this.toServer(row as Row) : null
  }

  create(input: {
    name: string
    command: string
    args: string[]
    env: { key: string; secretRef: string }[]
  }): McpServer {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.name,
        input.command,
        JSON.stringify(input.args),
        JSON.stringify(input.env),
        nowIso(),
      )
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id)
    if (!row) throw new Error('mcp server not found after create')
    return this.toServer(row as Row)
  }

  /** 运行状态与工具数由管理服务回写。 */
  updateRuntime(
    id: string,
    update: {
      status: 'disabled' | 'ready' | 'failed'
      toolCount: number
      lastError: string | null
    },
  ): McpServer {
    this.db
      .prepare(
        'UPDATE mcp_servers SET status = ?, tool_count = ?, last_error = ?, updated_at = ? WHERE id = ?',
      )
      .run(update.status, update.toolCount, update.lastError, nowIso(), id)
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id)
    if (!row) throw new Error('mcp server not found after update')
    return this.toServer(row as Row)
  }

  toggle(id: string): McpServer | null {
    const current = this.get(id)
    if (!current) return null
    this.db
      .prepare(
        'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?',
      )
      .run(current.enabled ? 0 : 1, nowIso(), id)
    return this.get(id)
  }

  remove(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM mcp_servers WHERE id = ?')
      .run(id)
    return Number(result.changes) > 0
  }

  private toServer(row: Row): McpServer {
    let args: string[] = []
    let env: { key: string; secretRef: string }[] = []
    try {
      const parsed = JSON.parse(String(row.args_json ?? '[]'))
      if (Array.isArray(parsed)) args = parsed.map(String)
    } catch {
      args = []
    }
    try {
      const parsed = JSON.parse(String(row.env_json ?? '[]'))
      if (Array.isArray(parsed)) {
        env = parsed.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const item = entry as Record<string, unknown>
          return typeof item.key === 'string' &&
            typeof item.secretRef === 'string'
            ? [{ key: item.key, secretRef: item.secretRef }]
            : []
        })
      }
    } catch {
      env = []
    }
    return {
      id: String(row.id),
      name: String(row.name),
      command: String(row.command),
      args,
      env,
      enabled: Number(row.enabled) === 1,
      toolCount: Number(row.tool_count ?? 0),
      status: String(row.status ?? 'disabled') as McpServer['status'],
      lastError: row.last_error == null ? null : String(row.last_error),
      updatedAt: String(row.updated_at),
    }
  }
}
