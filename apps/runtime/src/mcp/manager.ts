import {
  JsonValueSchema,
  type McpServer,
  type McpTool,
  type ToolSpec,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import type { Store } from '../store/index.js'
import { McpClient, type McpServerConfig } from './client.js'
import { loadSecret } from '../secrets.js'

interface ConnectedServer {
  server: McpServer
  client: McpClient
  tools: McpTool[]
}

/**
 * MCP 管理服务:按存储配置 spawn 协议 client(握手+工具枚举),
 * 把工具桥成 Agent 侧 ToolSpec;任何连接失败标记 failed 并由 UI 可重连。
 * 生命周期由 Runtime 进程持有,重启后自动恢复。
 */
export class McpManager {
  private readonly clients = new Map<string, ConnectedServer>()

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
  ) {}

  list(): McpServer[] {
    return this.store.mcpServers.list()
  }

  add(input: {
    name: string
    command: string
    args: string[]
    env: { key: string; secretRef: string }[]
  }): McpServer {
    return this.store.mcpServers.create(input)
  }

  remove(id: string): boolean {
    const connected = this.clients.get(id)
    connected?.client.dispose()
    this.clients.delete(id)
    return this.store.mcpServers.remove(id)
  }

  async toggle(id: string): Promise<McpServer | null> {
    const current = this.store.mcpServers.get(id)
    if (!current) return null
    const server = this.store.mcpServers.toggle(id)
    if (!server) return null
    const connected = this.clients.get(id)
    connected?.client.dispose()
    this.clients.delete(id)
    if (server.enabled) {
      await this.connect(server)
    } else {
      this.emitChanged(
        this.store.mcpServers.updateRuntime(id, {
          status: 'disabled',
          toolCount: 0,
          lastError: null,
        }),
      )
    }
    return this.store.mcpServers.get(id)
  }

  async reload(): Promise<McpServer[]> {
    // 先断开全部旧连接。
    for (const [id, connected] of this.clients) {
      connected.client.dispose()
      this.clients.delete(id)
    }
    const servers = this.store.mcpServers.list()
    for (const server of servers) {
      await this.connect(server)
    }
    return this.store.mcpServers.list()
  }

  /** 全部就绪工具的协议声明(供 createToolRegistry 注册);toolName 为服务器原始名。 */
  allTools(): { serverId: string; toolName: string; spec: ToolSpec }[] {
    const tools: { serverId: string; toolName: string; spec: ToolSpec }[] = []
    for (const [serverId, connected] of this.clients) {
      for (const tool of connected.tools) {
        tools.push({
          serverId,
          toolName: tool.name,
          spec: {
            name: `${serverId}/${tool.name}`,
            description:
              `[MCP ${connected.server.name}] ${tool.description}`.trim(),
            parameters: tool.inputSchema as ToolSpec['parameters'],
          },
        })
      }
    }
    return tools
  }

  /** 全部已连接 server 的工具清单(协议层原始名,供 UI 呈现)。 */
  listTools(): McpTool[] {
    const tools: McpTool[] = []
    for (const [, connected] of this.clients) {
      tools.push(...connected.tools)
    }
    return tools
  }

  /** 执行一次 MCP 工具调用;失败折叠为错误文本(与内置工具处理一致)。 */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const connected = this.clients.get(serverId)
    if (!connected) {
      return {
        content: `MCP 服务器 ${serverId} 未连接`,
        isError: true,
      }
    }
    try {
      const text = await connected.client.callTool(toolName, args)
      return { content: text, isError: false }
    } catch (error) {
      return {
        content: `MCP 工具 ${toolName} 调用失败: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }

  /** 连接单台(配置为 enabled 时);更新运行状态并广播 mcp.changed。 */
  private async connect(server: McpServer): Promise<void> {
    if (!server.enabled) {
      this.emitChanged(
        this.store.mcpServers.updateRuntime(server.id, {
          status: 'disabled',
          toolCount: 0,
          lastError: null,
        }),
      )
      return
    }
    let client: McpClient | null = null
    try {
      const config: McpServerConfig = {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(
          server.env.flatMap((entry) => {
            const value = loadSecret(entry.secretRef)
            return value === undefined ? [] : [[entry.key, value]]
          }),
        ),
      }
      client = new McpClient(config)
      await client.connect()
      const specs = await client.listTools()
      const tools: McpTool[] = specs.map((spec) => ({
        serverId: server.id,
        name: spec.name,
        description: spec.description ?? '',
        inputSchema: JsonValueSchema.parse(
          spec.inputSchema === undefined ? {} : spec.inputSchema,
        ),
      }))
      this.clients.set(server.id, { server, client, tools })
      this.emitChanged(
        this.store.mcpServers.updateRuntime(server.id, {
          status: 'ready',
          toolCount: tools.length,
          lastError: null,
        }),
      )
    } catch (error) {
      client?.dispose()
      const message = error instanceof Error ? error.message : String(error)
      this.emitChanged(
        this.store.mcpServers.updateRuntime(server.id, {
          status: 'failed',
          toolCount: 0,
          lastError: message,
        }),
      )
    }
  }

  /** dispose 全部连接(Runtime 退出/重建时)。 */
  dispose(): void {
    for (const [, connected] of this.clients) {
      connected.client.dispose()
    }
    this.clients.clear()
  }

  private emitChanged(server: McpServer): void {
    const emitter = new RunEventEmitter(server.id, this.notifier)
    emitter.next({ type: 'mcp.changed', serverId: server.id, server })
  }
}
