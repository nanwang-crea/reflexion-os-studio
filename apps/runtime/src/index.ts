import { createInterface } from 'node:readline'
import {
  JsonRpcMessageSchema,
  PROTOCOL_VERSION,
  lookupCommandSchema,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RuntimeEvent,
  type RuntimeStatus,
} from '@reflexion-os-studio/contracts'
import { ChatAgent, CommandError } from './agent/index.js'
import { sweepOrphanMemoryDirs } from './agent/instructions/service.js'
import { ResourceEventEmitter } from './events.js'
import { dispatchCommand, testProviderConnection } from './handlers.js'
import { resolveDataDir, Store } from './store/index.js'
import { resolveSystemRuntimeBinary, SystemRuntimeClient } from './system.js'
import { applyUserShellEnv } from './user-shell-env.js'
import { McpManager } from './mcp/manager.js'
import { WorkspaceIndexer } from './workspace/indexer.js'
import { AssetService } from './assets/service.js'
import { TerminalService } from './terminal/service.js'

const RUNTIME_VERSION = '0.1.0'

/**
 * Rust → TS 通知路由：terminal.* 交终端服务，未知 terminal.* 记调试行。
 * terminalService 在其后构造（依赖 store），用可变盒子闭包延迟绑定；通知只在 start() 后到达。
 */
const terminalServiceBox: { current?: TerminalService } = {}
function routeSystemNotification(method: string, params: unknown): void {
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

function write(message: JsonRpcMessage, onFlush?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, onFlush)
}

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

function notify(event: RuntimeEvent): void {
  write({ jsonrpc: '2.0', method: event.type, params: event })
}

// 全局状态事件信封（runtime 作用域，不归属任何 Run）。
const statusEmitter = new ResourceEventEmitter({ scope: 'runtime' }, notify)

// 方案 A：TS Runtime 拥有 Rust System Runtime 的通道与生命周期；
// 系统可用性第一手在此产生，经 runtime.status 事件上报（Host/前端据此投影）。
const systemRuntime = new SystemRuntimeClient(
  resolveSystemRuntimeBinary(),
  [],
  (status, detail) => {
    process.stderr.write(
      `[runtime] system runtime ${status}${detail ? `: ${detail}` : ''}\n`,
    )
    // sidecar 离开 ready：其上的 PTY 已死，把活动终端标记 disconnected（不自动重跑）。
    if (status !== 'ready') {
      terminalServiceBox.current?.markAllDisconnected(String(status))
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

function summarizeZodIssues(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.') || '(root)'
    return `${path}: ${issue.message}`
  })
}

const store = new Store(resolveDataDir())
const mcpManager = new McpManager(store, notify)
const agent = new ChatAgent(store, notify, systemRuntime, mcpManager)
const workspaceIndexer = new WorkspaceIndexer(store, notify)
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
const commandContext = {
  store,
  agent,
  approvals: agent.approvals,
  workspace: workspaceIndexer,
  system: systemRuntime,
  mcp: mcpManager,
  assets: assetService,
  terminal: terminalService,
}

// P1 环境继承：先探测用户 shell 环境快照（不阻塞 Chat 就绪），
// 但 Rust sidecar 与 MCP server 的 spawn 必须等注入完成，才能继承补齐后的 PATH/env。
const userShellEnvReady = applyUserShellEnv()
void userShellEnvReady
  .then(async () => {
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
    // 先收终端（对每个 shell 发协议 close），再协议关停 Rust 子进程，最后退自身；
    // 宿主侧另有进程树兜底收割。顺序保持：terminal → system → mcp dispose → exit。
    sendResponse(request.id, { ok: true }, () => {
      void terminalService
        .shutdown()
        .catch((error: unknown) => {
          process.stderr.write(
            `[runtime] terminal shutdown error: ${String(error)}\n`,
          )
        })
        .finally(() => {
          void systemRuntime.shutdown().finally(() => {
            mcpManager.dispose()
            process.exit(0)
          })
        })
    })
    return
  }

  const entry = lookupCommandSchema(request.method)
  if (!entry) {
    sendError(request.id, -32601, `Method not found: ${request.method}`)
    return
  }

  const params = entry.params.safeParse(request.params ?? {})
  if (!params.success) {
    sendError(
      request.id,
      -32602,
      'Invalid params',
      summarizeZodIssues(params.error),
    )
    return
  }

  if (request.method === 'runtime.get_status') {
    sendResponse(request.id, getStatus())
    return
  }

  if (request.method === 'provider.test') {
    // 连接测试涉及网络等待：异步执行，完成后单独回包（JSON-RPC 不要求按序响应）。
    void testProviderConnection(params.data as Record<string, unknown>).then(
      (result) => sendResponse(request.id, result),
      (error: unknown) => {
        if (error instanceof CommandError) {
          sendError(request.id, -32000, error.message, {
            code: error.code,
            message: error.message,
          })
          return
        }
        sendError(request.id, -32000, 'internal error', {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return
  }

  try {
    const result = await dispatchCommand(
      request.method,
      params.data as Record<string, unknown>,
      commandContext,
    )
    sendResponse(request.id, result)
  } catch (error) {
    if (error instanceof CommandError) {
      // 业务错误同步落 stderr，便于从终端排障；stdout 仍只传协议。
      process.stderr.write(
        `[runtime] ${request.method} failed (${error.code}): ${error.message}\n`,
      )
      sendError(request.id, -32000, error.message, {
        code: error.code,
        message: error.message,
      })
      return
    }
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[runtime] ${request.method} internal error: ${detail}\n`,
    )
    sendError(request.id, -32000, 'internal error', {
      code: 'internal',
      message: detail,
    })
  }
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
  if ('method' in message && 'id' in message) {
    handleRequest(message)
    return
  }

  process.stderr.write(
    `[runtime] ignored ${'method' in message ? 'notification' : 'response'}\n`,
  )
})
