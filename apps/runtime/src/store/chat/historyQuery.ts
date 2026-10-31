import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Row } from '../shared.js'
import {
  assertReadQuery,
  cellValue,
  MAX_RESULT_ROWS,
} from './history-query/sql.js'

interface TableColumn {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** A project-scoped, in-memory snapshot for model-authored read-only SQL. */
export class HistoryQueryStore {
  private readonly source: DatabaseSync

  constructor(dataDir: string) {
    this.source = new DatabaseSync(join(dataDir, 'reflexion.db'), {
      readOnly: true,
      timeout: 3000,
    })
  }

  close(): void {
    this.source.close()
  }

  schema() {
    return this.tableDefinitions()
      .filter((table) => this.isHistoryTable(table.name, table.columns))
      .map(({ name, columns }) => ({ name, columns }))
  }

  query(input: {
    sql: string
    params: Array<string | number | null>
    sessionIds: string[]
    projectId: string | null
    scope: 'current_session' | 'project'
  }) {
    assertReadQuery(input.sql)
    const snapshot = this.createSnapshot(
      input.sessionIds,
      input.projectId,
      input.scope,
    )
    try {
      snapshot.db.exec('PRAGMA query_only = ON')
      const statement = snapshot.db.prepare(input.sql)
      statement.setReturnArrays(false)
      const rows: Record<string, unknown>[] = []
      const iterator = statement.iterate(...input.params)
      let truncated = false
      for (const row of iterator) {
        if (rows.length === MAX_RESULT_ROWS) {
          truncated = true
          break
        }
        rows.push(
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, cellValue(value)]),
          ),
        )
      }
      return { rows, truncated, maxRows: MAX_RESULT_ROWS }
    } finally {
      snapshot.db.close()
    }
  }

  private createSnapshot(
    sessionIds: string[],
    projectId: string | null,
    scope: 'current_session' | 'project',
  ) {
    const snapshot = new DatabaseSync(':memory:')
    snapshot.exec('PRAGMA foreign_keys = OFF')
    const tableDefinitions = this.tableDefinitions()

    for (const table of tableDefinitions) snapshot.exec(table.sql)

    const scopedSessionIds = this.expandSessionIds(sessionIds, projectId)
    const runIds = this.runIdsForSessions(scopedSessionIds)
    for (const table of tableDefinitions) {
      const filter = this.scopeFilter(table.name, table.columns, {
        sessionIds: scopedSessionIds,
        runIds,
        projectId,
        scope,
      })
      if (!filter) continue
      const sourceRows = this.source
        .prepare(`SELECT * FROM ${identifier(table.name)} WHERE ${filter.sql}`)
        .all(...filter.params) as Row[]
      if (sourceRows.length === 0) continue
      const names = table.columns.map((column) => identifier(column.name))
      const insert = snapshot.prepare(
        `INSERT INTO ${identifier(table.name)} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      )
      for (const row of sourceRows) {
        insert.run(...table.columns.map((column) => row[column.name] as never))
      }
    }

    return {
      db: snapshot,
      tables: tableDefinitions,
    }
  }

  private columns(table: string): TableColumn[] {
    return this.source
      .prepare(`PRAGMA table_info(${identifier(table)})`)
      .all()
      .map((row) => {
        const value = row as Row
        return {
          name: String(value.name),
          type: String(value.type ?? ''),
          notNull: Number(value.notnull) === 1,
          primaryKey: Number(value.pk) > 0,
        }
      })
  }

  private tableDefinitions() {
    const definitions = this.source
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Row[]
    return definitions.flatMap((row) => {
      const name = String(row.name)
      const sql = row.sql == null ? '' : String(row.sql)
      if (!/^CREATE TABLE\b/i.test(sql.trim())) return []
      const columns = this.columns(name)
      return this.isHistoryTable(name, columns) ? [{ name, sql, columns }] : []
    })
  }

  private expandSessionIds(
    sessionIds: string[],
    projectId: string | null,
  ): string[] {
    if (sessionIds.length === 0) return []
    const scopedSessions = new Set(sessionIds)
    const runRows = this.source
      .prepare(
        `SELECT id, session_id, parent_run_id FROM runs WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`,
      )
      .all(...sessionIds) as Row[]
    let frontier = runRows.map((row) => String(row.id))
    const runIds = new Set(frontier)
    while (frontier.length > 0) {
      const children = this.source
        .prepare(
          `SELECT id, session_id FROM runs WHERE parent_run_id IN (${frontier.map(() => '?').join(', ')})`,
        )
        .all(...frontier) as Row[]
      const childSessionIds = children.map((row) => String(row.session_id))
      const visibleChildren =
        childSessionIds.length === 0
          ? []
          : (
              this.source
                .prepare(
                  `SELECT id FROM sessions WHERE id IN (${childSessionIds.map(() => '?').join(', ')}) AND project_id IS ?`,
                )
                .all(...childSessionIds, projectId) as Row[]
            ).map((row) => String(row.id))
      const allowedSessions = new Set(visibleChildren)
      frontier = []
      for (const child of children) {
        const id = String(child.id)
        if (!runIds.has(id) && allowedSessions.has(String(child.session_id))) {
          runIds.add(id)
          scopedSessions.add(String(child.session_id))
          frontier.push(id)
        }
      }
    }
    return [...scopedSessions]
  }

  private runIdsForSessions(sessionIds: string[]): string[] {
    if (sessionIds.length === 0) return []
    return (
      this.source
        .prepare(
          `SELECT id FROM runs WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`,
        )
        .all(...sessionIds) as Row[]
    ).map((row) => String(row.id))
  }

  private scopeFilter(
    tableName: string,
    columns: TableColumn[],
    scope: {
      sessionIds: string[]
      runIds: string[]
      projectId: string | null
      scope: 'current_session' | 'project'
    },
  ): { sql: string; params: string[] } | null {
    const names = new Set(columns.map((column) => column.name))
    if (tableName === 'projects') {
      return scope.projectId && scope.scope === 'project'
        ? { sql: 'id = ?', params: [scope.projectId] }
        : null
    }
    if (tableName === 'sessions') {
      return this.inFilter('id', scope.sessionIds)
    }
    if (names.has('session_id'))
      return this.inFilter('session_id', scope.sessionIds)
    if (names.has('run_id')) return this.inFilter('run_id', scope.runIds)
    if (names.has('parent_run_id'))
      return this.inFilter('parent_run_id', scope.runIds)
    if (names.has('root_run_id'))
      return this.inFilter('root_run_id', scope.runIds)
    if (names.has('project_id') && scope.projectId && scope.scope === 'project')
      return { sql: 'project_id = ?', params: [scope.projectId] }
    return null
  }

  private inFilter(
    column: string,
    values: string[],
  ): { sql: string; params: string[] } | null {
    if (values.length === 0) return null
    return {
      sql: `${identifier(column)} IN (${values.map(() => '?').join(', ')})`,
      params: values,
    }
  }

  private isHistoryTable(name: string, columns: TableColumn[]): boolean {
    return (
      name === 'projects' ||
      name === 'sessions' ||
      columns.some((column) =>
        [
          'project_id',
          'session_id',
          'run_id',
          'parent_run_id',
          'root_run_id',
        ].includes(column.name),
      )
    )
  }
}
