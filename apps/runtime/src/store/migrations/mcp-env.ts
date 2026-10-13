import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SecretStore } from '../../secrets.js'
import { nowIso } from '../shared.js'

/**
 * v15 → v16：把 mcp_servers.env_json 中的旧明文 {key, value} 逐条迁入
 * Secret Store，替换为 {key, secretRef}。Secret Store 与 DB 同目录（dir）。
 * 迁移在 runMigrations 的事务内执行：任一失败由外层 ROLLBACK 回滚整库，
 * 此处同步清除已写入的密钥引用，避免明文残留或孤儿密钥。
 */
export function migrateMcpEnvSecrets(db: DatabaseSync, dir: string): void {
  const rows = db.prepare('SELECT id, env_json FROM mcp_servers').all() as {
    id: string
    env_json: string | null
  }[]
  if (rows.length === 0) return
  const secretStore = new SecretStore(dir)
  const created: string[] = []
  try {
    const update = db.prepare(
      'UPDATE mcp_servers SET env_json = ?, updated_at = ? WHERE id = ?',
    )
    for (const row of rows) {
      let env: unknown[] = []
      try {
        const parsed: unknown = JSON.parse(String(row.env_json ?? '[]'))
        if (Array.isArray(parsed)) env = parsed
      } catch {
        // 非法 JSON 按空环境处理，并在迁移中规范化落库。
      }
      // 迁移后 env_json 只允许稳定的 {key, secretRef} 形态；丢弃非法条目。
      const migrated = env.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const item = entry as Record<string, unknown>
        if (typeof item.key !== 'string' || item.key.length === 0) return []
        if (typeof item.secretRef === 'string' && item.secretRef.length > 0) {
          return [{ key: item.key, secretRef: item.secretRef }]
        }
        if (typeof item.value === 'string') {
          const secretRef = `local:${randomUUID()}`
          secretStore.save(secretRef, item.value)
          created.push(secretRef)
          return [{ key: item.key, secretRef }]
        }
        return []
      })
      const canonical = JSON.stringify(migrated)
      if (canonical !== String(row.env_json ?? '[]')) {
        update.run(canonical, nowIso(), String(row.id))
      }
    }
  } catch (error) {
    // 整库回滚交给 runMigrations 外层；此处只负责回收已写出的密钥引用。
    for (const ref of created) {
      try {
        secretStore.delete(ref)
      } catch {
        // 清理失败不掩盖迁移失败的主因。
      }
    }
    throw error
  }
}
