import type { SQLOutputValue } from 'node:sqlite'

const BLOCKED_SQL_TOKENS = new Set([
  'ALTER',
  'ANALYZE',
  'ATTACH',
  'BEGIN',
  'COMMIT',
  'CREATE',
  'DELETE',
  'DETACH',
  'DROP',
  'INSERT',
  'PRAGMA',
  'REINDEX',
  'RELEASE',
  'REPLACE',
  'ROLLBACK',
  'SAVEPOINT',
  'UPDATE',
  'VACUUM',
])

export const MAX_RESULT_ROWS = 50
const MAX_CELL_CHARS = 2000

function scanSqlTokens(sql: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '-' && next === '-') {
      index = sql.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) throw new Error('SQL 注释未闭合')
      index = end + 2
      continue
    }
    if (char === ';') {
      if (sql.slice(index + 1).trim() !== '')
        throw new Error('一次只能执行一条 SQL')
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      index += 1
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && char !== '[') {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index
      index += 1
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1
      tokens.push(sql.slice(start, index).toUpperCase())
      continue
    }
    index += 1
  }
  return tokens
}

export function assertReadQuery(sql: string): void {
  const tokens = scanSqlTokens(sql)
  if (tokens[0] !== 'SELECT' && tokens[0] !== 'WITH')
    throw new Error('只允许 SELECT 或 WITH ... SELECT 查询')
  const blocked = tokens.find((token) => BLOCKED_SQL_TOKENS.has(token))
  if (blocked) throw new Error(`只读查询中不允许 ${blocked}`)
}

export function cellValue(value: SQLOutputValue): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array)
    return `[二进制数据 ${value.byteLength} bytes]`
  if (typeof value === 'string' && value.length > MAX_CELL_CHARS)
    return `${value.slice(0, MAX_CELL_CHARS)}…[已截断]`
  return value
}
