import type { DatabaseSync } from 'node:sqlite'
import type { BrowserVisit } from '@reflexion-os-studio/contracts'
import { normalizeBrowserUrl } from '@reflexion-os-studio/contracts'

export class BrowserHistoryStore {
  constructor(private readonly db: DatabaseSync) {}
  record(raw: string, title: string): void {
    const url = normalizeBrowserUrl(raw)
    this.db
      .prepare(
        'INSERT INTO browser_history (url, origin, title, visited_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        url,
        new URL(url).origin,
        title.slice(0, 500),
        new Date().toISOString(),
      )
    this.db
      .prepare(
        'DELETE FROM browser_history WHERE id NOT IN (SELECT id FROM browser_history ORDER BY id DESC LIMIT 10000)',
      )
      .run()
  }
  list(query: string, limit: number, before?: number): BrowserVisit[] {
    const rows = this.db
      .prepare(
        `SELECT id, url, origin, title, visited_at FROM browser_history
      WHERE (? IS NULL OR id < ?) AND (instr(lower(url), lower(?)) > 0 OR instr(lower(title), lower(?)) > 0)
      ORDER BY id DESC LIMIT ?`,
      )
      .all(before ?? null, before ?? null, query, query, limit) as {
      id: number
      url: string
      origin: string
      title: string
      visited_at: string
    }[]
    return rows.map((row) => ({
      id: String(row.id),
      url: row.url,
      origin: row.origin,
      title: row.title,
      visitedAt: row.visited_at,
    }))
  }
  clear(origin?: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM browser_history WHERE (? IS NULL OR origin = ?)')
        .run(origin ?? null, origin ?? null).changes,
    )
  }
}
