import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export function nowIso(): string {
  return new Date().toISOString()
}

export function resolveDataDir(): string {
  return (
    process.env.REFLEXION_DATA_DIR ?? join(homedir(), '.reflexion-os-studio')
  )
}

/** 新会话默认标题；Agent 用它判断是否需要根据首条消息自动命名。 */
export const DEFAULT_SESSION_TITLE = '新对话'

/** 各领域 Store 共用的行读取入口：node:sqlite 返回弱类型行。 */
export type Row = Record<string, unknown>
