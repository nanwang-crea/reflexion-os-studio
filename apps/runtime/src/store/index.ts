import { OperationReceiptStore } from './chat/operationReceipts.js'
import { ModelInvocationStore } from './diagnostics/modelInvocations.js'
import { DeveloperStore } from './diagnostics/index.js'
import { WorkflowDraftStore } from './workflows/authoring/drafts.js'
import { WorkflowGenerationStore } from './workflows/authoring/generations.js'
import { recoverWorkflows } from './workflows/execution/recovery.js'
import { WorkflowConfirmationStore } from './workflows/execution/confirmations.js'
import { WorkflowOutputStore } from './workflows/execution/outputs.js'
import { WorkflowAttemptStore } from './workflows/execution/attempts.js'
import { WorkflowRunStore } from './workflows/execution/runs.js'
import { WorkflowDefinitionStore } from './workflows/definitions.js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChatArchiveStore } from './chat/archives.js'
import { MessageStore } from './chat/messages.js'
import { HistoryQueryStore } from './chat/historyQuery.js'
import { ProjectStore } from './chat/projects.js'
import { RunStore } from './chat/runs.js'
import { SessionStore } from './chat/sessions.js'
import { ToolCallStore } from './chat/toolCalls.js'
import { UserInteractionStore } from './chat/interactions.js'
import { TurnExecutionStore } from './chat/turnExecutions.js'
import { PlanDocumentStore } from './chat/planDocuments.js'
import { PlanStore } from './chat/plans.js'
import { RunEventStore } from './chat/runEvents.js'
import { AgentSettingsStore } from './agents/agentSettings.js'
import { BrowserHistoryStore } from './integrations/browserHistory.js'
import { BrowserContactsStore } from './integrations/browserContacts.js'
import { BrowserSettingsStore } from './integrations/browserSettings.js'
import { AgentStore } from './agents/agents.js'
import { BUILTIN_AGENTS } from './agents/builtins.js'
import { ContextCheckpointStore } from './agents/contextCheckpoints.js'
import { DelegationStore } from './agents/delegations.js'
import { MutationReceiptStore } from './agents/mutationReceipts.js'
import { McpServerStore } from './integrations/mcpServers.js'
import { PluginStore } from './integrations/plugins.js'
import { ProviderStore } from './integrations/providers.js'
import { ProviderModelStore } from './integrations/providerModels.js'
import { AssetStore } from './workspace/assets.js'
import { WorkspaceIndexStore } from './workspace/workspaceIndex.js'
import { runMigrations } from './migrations.js'
import { SCHEMA } from './schema.js'

export { DEFAULT_SESSION_TITLE, resolveDataDir } from './shared.js'

/**
 * 领域门面：各领域 Store 共享同一 SQLite 连接与事务边界。
 * 依赖方向：handlers/agent → Store 领域对象，不直接触碰 SQL。
 */
export class Store {
  private readonly db: DatabaseSync
  readonly operationReceipts: OperationReceiptStore
  readonly modelInvocations: ModelInvocationStore
  readonly developer: DeveloperStore
  readonly projects: ProjectStore
  readonly sessions: SessionStore
  readonly chatArchives: ChatArchiveStore
  readonly messages: MessageStore
  readonly historyQuery: HistoryQueryStore
  readonly runs: RunStore
  readonly toolCalls: ToolCallStore
  readonly interactions: UserInteractionStore
  readonly turnExecutions: TurnExecutionStore
  readonly providers: ProviderStore
  readonly providerModels: ProviderModelStore
  readonly workspaceIndex: WorkspaceIndexStore
  readonly assetStore: AssetStore
  readonly agentSettings: AgentSettingsStore
  readonly browserHistory: BrowserHistoryStore
  readonly browserContacts: BrowserContactsStore
  readonly browserSettings: BrowserSettingsStore
  readonly mcpServers: McpServerStore
  readonly planDocuments: PlanDocumentStore
  readonly plans: PlanStore
  readonly agents: AgentStore
  readonly delegations: DelegationStore
  readonly mutationReceipts: MutationReceiptStore
  readonly runEvents: RunEventStore
  readonly contextCheckpoints: ContextCheckpointStore
  readonly plugins: PluginStore
  readonly workflowRuns: WorkflowRunStore
  readonly workflowAttempts: WorkflowAttemptStore
  readonly workflowOutputs: WorkflowOutputStore
  readonly workflowConfirmations: WorkflowConfirmationStore
  readonly workflowDrafts: WorkflowDraftStore
  readonly workflowGenerations: WorkflowGenerationStore
  readonly workflows: WorkflowDefinitionStore

  constructor(readonly dataDir: string) {
    const dir = dataDir
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'reflexion.db'))
    this.db.exec('PRAGMA foreign_keys = ON')
    // node:sqlite 默认无 busy_timeout：多实例共存（误重复启动）时，
    // 启动恢复/事务撞上另一实例的写锁会直接抛 SQLITE_BUSY 打挂 Runtime。
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    runMigrations(this.db, dir)
    this.modelInvocations = new ModelInvocationStore(this.db)
    this.modelInvocations.recover()

    this.operationReceipts = new OperationReceiptStore(this.db)
    this.operationReceipts.recover()
    this.projects = new ProjectStore(this.db)
    this.sessions = new SessionStore(this.db)
    this.chatArchives = new ChatArchiveStore(this.db)
    this.messages = new MessageStore(this.db)
    this.historyQuery = new HistoryQueryStore(dir)
    this.runs = new RunStore(this.db)
    this.toolCalls = new ToolCallStore(this.db)
    this.developer = new DeveloperStore(this.db, this.runs, this.toolCalls)
    this.interactions = new UserInteractionStore(this.db)
    this.turnExecutions = new TurnExecutionStore(this.db)
    this.providers = new ProviderStore(this.db)
    this.providerModels = new ProviderModelStore(this.db)
    this.workspaceIndex = new WorkspaceIndexStore(this.db)
    this.assetStore = new AssetStore(this.db)
    this.agentSettings = new AgentSettingsStore(this.db)
    this.browserHistory = new BrowserHistoryStore(this.db)
    this.browserContacts = new BrowserContactsStore(this.db)
    this.browserSettings = new BrowserSettingsStore(this.db)
    this.mcpServers = new McpServerStore(this.db)
    this.plans = new PlanStore(this.db)
    this.planDocuments = new PlanDocumentStore(this.db)
    this.agents = new AgentStore(this.db)
    this.delegations = new DelegationStore(this.db)
    this.mutationReceipts = new MutationReceiptStore(this.db)
    this.runEvents = new RunEventStore(this.db)
    this.contextCheckpoints = new ContextCheckpointStore(this.db)
    this.workflowDrafts = new WorkflowDraftStore(this.db)
    this.workflowGenerations = new WorkflowGenerationStore(this.db)
    this.workflowRuns = new WorkflowRunStore(this.db)
    this.workflowAttempts = new WorkflowAttemptStore(this.db)
    this.workflowOutputs = new WorkflowOutputStore(this.db)
    this.workflowConfirmations = new WorkflowConfirmationStore(this.db)
    this.plugins = new PluginStore(this.db)
    this.workflows = new WorkflowDefinitionStore(this.db, (fn) =>
      this.transaction(fn),
    )
    for (const agent of BUILTIN_AGENTS) {
      const current = this.agents.get(agent.id)
      this.agents.upsert({
        ...agent,
        // 内置元数据可随版本升级，用户的启停选择必须跨重启保留。
        enabled: current?.enabled ?? agent.enabled,
      })
    }

    // Turn reducer 是恢复判定的唯一入口；旧库中没有 Turn 的 Run 仍由下方
    // 领域清扫兼容收敛。只有持久化 user interaction 可跨进程安全续跑。
    this.recoverRuntimeState()
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

  /**
   * 唯一启动恢复入口。Turn reducer 先决定续跑或中断，领域 Store 只负责把
   * 该决定投影到兼容行；仅顶层等待输入可续跑。计划保持 active，不在 Run
   * 终态时隐式收敛。
   */
  private recoverRuntimeState(): void {
    this.turnExecutions.recoverNonTerminal()
    this.runs.recoverInterrupted()
    this.interactions.recoverUnresumable()
    this.delegations.recoverInterrupted()
    this.messages.recoverInterrupted()
    this.toolCalls.recoverUnfinished()
    this.workspaceIndex.recoverInterrupted()
    recoverWorkflows(this)
    this.workflowGenerations.recover()
  }

  close(): void {
    this.historyQuery.close()
    this.db.close()
  }
}
