import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MessageStore } from './messages.js'
import { MemoryStore } from './memories.js'
import { ProviderStore } from './providers.js'
import { ProjectStore } from './projects.js'
import { RunStore } from './runs.js'
import { AgentSettingsStore } from './agentSettings.js'
import { McpServerStore } from './mcpServers.js'
import { runMigrations, SCHEMA } from './migrations.js'
import { SessionStore } from './sessions.js'
import { ToolCallStore } from './toolCalls.js'
import { WorkspaceIndexStore } from './workspaceIndex.js'

export { DEFAULT_SESSION_TITLE, resolveDataDir } from './shared.js'

/**
 * 领域门面：各领域 Store 共享同一 SQLite 连接与事务边界。
 * 依赖方向：handlers/agent → Store 领域对象，不直接触碰 SQL。
 */
export class Store {
  private readonly db: DatabaseSync
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly messages: MessageStore
  readonly runs: RunStore
  readonly toolCalls: ToolCallStore
  readonly providers: ProviderStore
  readonly memories: MemoryStore
  readonly workspaceIndex: WorkspaceIndexStore
  readonly agentSettings: AgentSettingsStore
  readonly mcpServers: McpServerStore

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'reflexion.db'))
    this.db.exec('PRAGMA foreign_keys = ON')
    // node:sqlite 默认无 busy_timeout：多实例共存（误重复启动）时，
    // 启动恢复/事务撞上另一实例的写锁会直接抛 SQLITE_BUSY 打挂 Runtime。
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    runMigrations(this.db)

    this.projects = new ProjectStore(this.db)
    this.sessions = new SessionStore(this.db)
    this.messages = new MessageStore(this.db)
    this.runs = new RunStore(this.db)
    this.toolCalls = new ToolCallStore(this.db)
    this.providers = new ProviderStore(this.db)
    this.memories = new MemoryStore(this.db)
    this.workspaceIndex = new WorkspaceIndexStore(this.db)
    this.agentSettings = new AgentSettingsStore(this.db)
    this.mcpServers = new McpServerStore(this.db)

    // 启动恢复：上次进程未走完的生命周期统一落为 interrupted/cancelled。
    this.runs.recoverInterrupted()
    this.messages.recoverInterrupted()
    this.toolCalls.recoverUnfinished()
    this.workspaceIndex.recoverInterrupted()
  }

  /** 单事务边界：同连接上的多个领域写入要么全部提交要么全部回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
