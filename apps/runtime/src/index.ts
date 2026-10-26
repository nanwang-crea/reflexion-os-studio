import { RuntimeEventBus } from './access/events.js'
import { RuntimeRequestGateway } from './access/requests/gateway.js'
import { RemoteAccessService } from './access/remote/service.js'
import { RemoteLiveState } from './access/remote/state/live-state.js'
import { RemoteAccessPolicy } from './access/remote/auth/policy.js'
import type { CommandContext } from './command-utils.js'
import { HostBrowserTransport } from './browser/agent/embedded/host.js'
import { registerDeveloperNotifications } from './diagnostics/events.js'
import { BrowserAgentService } from './browser/agent/service.js'
import { OperationRegistry, registerOperations } from './operations/index.js'
import { cleanupPlanDocuments } from './agent/tools/plan-documents.js'
import { createInterface } from 'node:readline'
import {
  JsonRpcMessageSchema,
  PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RuntimeEvent,
  type RuntimeStatus,
} from '@reflexion-os-studio/contracts'
import { ChatAgent } from './agent/index.js'
import { sweepOrphanMemoryDirs } from './agent/instructions/service.js'
import { ResourceEventEmitter } from './events.js'
import { dispatchCommand, testProviderConnection } from './handlers.js'
import { resolveDataDir, Store } from './store/index.js'
import { resolveSystemRuntimeBinary, SystemRuntimeClient } from './system.js'
import { applyUserShellEnv } from './user-shell-env.js'
import { McpManager } from './mcp/manager.js'
import { WorkspaceIndexer } from './workspace/indexer.js'
import { WorkspaceWatchService } from './workspace/watch-service.js'
import { AssetService } from './assets/service.js'
import { TerminalService } from './terminal/service.js'
import { SkillPluginService } from './skills/service.js'
import { acquireDataDirectoryLock } from './lifecycle/data-directory-lock.js'
import { createHostConnection } from './lifecycle/host-connection.js'
import { createRuntimeShutdown } from './lifecycle/shutdown.js'

const RUNTIME_VERSION = '0.1.0'

/**
 * Rust → TS 通知路由：terminal.* 交终端服务，未知 terminal.* 记调试行。
 * terminalService 在其后构造（依赖 store），用可变盒子闭包延迟绑定；通知只在 start() 后到达。
 */
const terminalServiceBox: { current?: TerminalService } = {}
const workspaceWatchBox: { current?: WorkspaceWatchService } = {}
function routeSystemNotification(method: string, params: unknown): void {
  if (method === 'file.changed') {
    workspaceWatchBox.current?.handleNotification(method, params)
    return
  }
  if (method.startsWith('terminal.')) {
    const service = terminalServiceBox.current
    if (!service) {
      process.stderr.write(
        `[runtime] drop ${method}: terminal service not ready\n`,
      )
      return
    }
    service.handleRustNotification(method, params)
    return
  }
  // 其他通知目前无消费者（system.ready 走 status，其余为请求响应）。
}

const write = createHostConnection(
  {
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
  },
  () => {
    browserHost?.dispose()
    void shutdown.run()
  },
)

function sendResponse(
  id: string | number,
  result: unknown,
  onFlush?: () => void,
): void {
  const message: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    result,
  }
  write(message, onFlush)
}

function sendError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  write({
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  })
}

const eventBus = new RuntimeEventBus(() => {
  process.stderr.write('[runtime] event subscriber failed\n')
})
const liveState = new RemoteLiveState()
eventBus.subscribe(liveState.accept)
eventBus.subscribe((event) =>
  write({ jsonrpc: '2.0', method: event.type, params: event }),
)
const notify = (event: RuntimeEvent): void => eventBus.publish(event)

// 全局状态事件信封（runtime 作用域，不归属任何 Run）。
const statusEmitter = new ResourceEventEmitter({ scope: 'runtime' }, notify)

// 方案 A：TS Runtime 拥有 Rust System Runtime 的通道与生命周期；
// 系统可用性第一手在此产生，经 runtime.status 事件上报（Host/前端据此投影）。
const cleanupPlans = (): void => {
  void cleanupPlanDocuments(store, systemRuntime).catch(() => {})
}

const agentBox: { current: ChatAgent | null } = { current: null }
const systemRuntime = new SystemRuntimeClient(
  resolveSystemRuntimeBinary(),
  [],
  (status, detail) => {
    process.stderr.write(
      `[runtime] system runtime ${status}${detail ? `: ${detail}` : ''}\n`,
    )
    // sidecar 离开 ready：其上的 PTY 已死，把活动终端标记 disconnected（不自动重跑）。
    if (status === 'ready') cleanupPlans()
    if (status !== 'ready') {
      terminalServiceBox.current?.markAllDisconnected(String(status))
      workspaceWatchBox.current?.clear()
      // Danger 硬边界随 provider 失效：租约必须立即撤销（fail-closed），
      // 绝不在无沙箱兜底时维持系统范围访问。
      agentBox.current?.danger.onProviderDegraded()
    }
    statusEmitter.next({ type: 'runtime.status', status: getStatus() })
  },
  routeSystemNotification,
)

function getStatus(): RuntimeStatus {
  return {
    state: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['chat'],
    chatAvailable: true,
    systemAvailable: systemRuntime.available,
  }
}

// Lock before migrations and recovery can touch another Runtime's active turns.
const dataDir = resolveDataDir()
const releaseDataDirectoryLock = acquireDataDirectoryLock(dataDir)
process.once('exit', releaseDataDirectoryLock)
const store = new Store(dataDir)
registerDeveloperNotifications(store, () =>
  statusEmitter.next({ type: 'developer.updated' }),
)
registerOperations(
  store,
  new OperationRegistry(
    (operation) => statusEmitter.next({ type: 'operation.changed', operation }),
    store.operationReceipts,
  ),
)
const skillPlugins = new SkillPluginService(store, resolveDataDir(), notify)
const mcpManager = new McpManager(store, notify)
const browserHost =
  process.env.REFLEXION_BROWSER_ENGINE === 'cef'
    ? new HostBrowserTransport(write)
    : undefined
const browser = new BrowserAgentService(
  store,
  undefined,
  undefined,
  browserHost,
)
const agent = new ChatAgent(
  store,
  notify,
  systemRuntime,
  mcpManager,
  skillPlugins.registry,
  browser,
  skillPlugins,
)
agentBox.current = agent
const workspaceIndexer = new WorkspaceIndexer(store, notify)
const workspaceWatch = new WorkspaceWatchService(systemRuntime, notify)
workspaceWatchBox.current = workspaceWatch
const assetService = new AssetService(store, resolveDataDir())
const terminalService = new TerminalService({
  getProject: (id) => {
    const project = store.projects.get(id)
    return project ? { folderPath: project.folderPath } : null
  },
  system: systemRuntime,
  notify,
})
terminalServiceBox.current = terminalService
const shutdown = createRuntimeShutdown(
  {
    remote: () => commandContext.remote?.stop(),
    terminal: () => terminalService.shutdown(),
    system: () => systemRuntime.shutdown(),
    browser: () => browser.shutdown(),
    browserHost: () => browserHost?.dispose(),
    agent: () => agent.dispose(),
    skills: () => skillPlugins.dispose(),
    workspaceWatch: () => workspaceWatch.clear(),
    mcp: () => mcpManager.dispose(),
  },
  (step, error) => {
    process.stderr.write(`[runtime] ${step} shutdown error: ${String(error)}\n`)
  },
  () => process.exit(0),
)
process.once('SIGTERM', () => void shutdown.run())
process.once('SIGINT', () => void shutdown.run())
const commandContext: CommandContext = {
  browser,
  store,
  agent,
  approvals: agent.approvals,
  interactions: agent.interactions,
  danger: agent.danger,
  workspace: workspaceIndexer,
  workspaceWatch,
  system: systemRuntime,
  mcp: mcpManager,
  assets: assetService,
  terminal: terminalService,
  plugins: skillPlugins,
}

const accessPolicy = new RemoteAccessPolicy(store)
const requestGateway = new RuntimeRequestGateway({
  authorize: accessPolicy.authorize,
  report: (message) => process.stderr.write(`[runtime] ${message}\n`),
  dispatch: async (method, params) => {
    if (method === 'runtime.get_status') return getStatus()
    if (method === 'provider.test') return testProviderConnection(params)
    return dispatchCommand(method, params, commandContext)
  },
})
commandContext.remote = new RemoteAccessService(
  commandContext,
  requestGateway,
  eventBus,
  liveState,
  accessPolicy,
)

// P1 环境继承：先探测用户 shell 环境快照（不阻塞 Chat 就绪），
// 但 Rust sidecar 与 MCP server 的 spawn 必须等注入完成，才能继承补齐后的 PATH/env。
const userShellEnvReady = applyUserShellEnv()
void userShellEnvReady
  .then(async () => {
    if (shutdown.started) return
    systemRuntime.start()
    // MCP:按配置连接全部已启用 server(失败标记 failed,不阻塞 Chat)。
    await mcpManager.reload()
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[runtime] sidecar bootstrap failed: ${String(error)}\n`,
    )
  })
// Asset Store 启动巡检/补偿清理：清理孤儿内容文件、标记缺内容的资产。
void assetService.recover().catch((error: unknown) => {
  process.stderr.write(`[runtime] asset recovery failed: ${String(error)}\n`)
})
// 记忆目录启动清扫：删除无项目行对应的孤儿项目记忆目录（与 Asset 巡检同期）。
void sweepOrphanMemoryDirs(store).catch((error: unknown) => {
  process.stderr.write(
    `[runtime] memory dir recovery failed: ${String(error)}\n`,
  )
})
// 初始状态上报：让 Host/前端立即拿到 systemAvailable 基线（后续变化走回调）。
statusEmitter.next({ type: 'runtime.status', status: getStatus() })

function handleRequest(request: JsonRpcRequest): void {
  void handleRequestAsync(request)
}

async function handleRequestAsync(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'system.ping') {
    // 工具健康检查代理：TS 转发给自有的 Rust 子进程。
    void systemRuntime.request('system.ping').then(
      () => sendResponse(request.id, { ok: true }),
      (error: unknown) =>
        sendResponse(request.id, {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }),
    )
    return
  }

  if (request.method === 'runtime.shutdown') {
    sendResponse(request.id, { ok: true }, () => {
      void shutdown.run()
    })
    return
  }

  write(await requestGateway.execute(request, { kind: 'desktop' }))
}

write({
  jsonrpc: '2.0',
  method: 'runtime.ready',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    capabilities: ['chat'],
  },
})

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  if (shutdown.started) return
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    sendError(null, -32700, 'Parse error')
    return
  }

  const parsed = JsonRpcMessageSchema.safeParse(value)
  if (!parsed.success) {
    sendError(null, -32600, 'Invalid Request')
    return
  }

  const message = parsed.data
  if (browserHost?.receive(message)) return
  if ('method' in message && 'id' in message) {
    handleRequest(message)
    return
  }

  process.stderr.write(
    `[runtime] ignored ${'method' in message ? 'notification' : 'response'}\n`,
  )
})
