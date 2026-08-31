import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

/** MCP 协议版本(2024-11-05 稳定版)。 */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** 请求超时(握手与工具调用共用;工具执行自身语义由 Agent 侧负责)。 */
const REQUEST_TIMEOUT_MS = 30_000

export interface McpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpToolSpec {
  name: string
  description: string
  inputSchema: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * MCP stdio client:初始化握手 → initialized 通知 → tools/list → tools/call。
 * 进程崩溃/握手失败都向上抛,由管理服务标记 failed;协议输出形如
 * JSON-RPC over stdio(stdout=协议,stderr=日志)。所有超时严格受控。
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private seq = 0

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    })
    if (!child.stdout || !child.stdin) {
      throw new Error('mcp server spawn produced no stdio pipes')
    }
    this.child = child
    child.on('error', (error) => {
      process.stderr.write(`[mcp] server process error: ${error.message}\n`)
    })
    const readline = createInterface({ input: child.stdout })
    readline.on('line', (line) => this.handleLine(line.trim()))
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[mcp] ${chunk.toString()}`)
    })
    child.once('exit', (code, signal) => {
      this.rejectPending(
        new Error(
          `mcp server exited (code=${String(code)} signal=${String(signal)})`,
        ),
      )
    })

    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'reflexion-os-studio', version: '0.1.0' },
    })
    this.notify('notifications/initialized', {})
  }

  /** 拉取服务器工具列表(名字未加前缀,协议层原始声明)。 */
  async listTools(): Promise<McpToolSpec[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolSpec[]
    }
    return result.tools ?? []
  }

  /** 调用工具;文本内容以 \n 连接返回。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean }
    if (result.isError === true) {
      throw new Error(
        result.content?.map((item) => item.text ?? '').join('\n') ||
          'mcp tool failed',
      )
    }
    return (
      result.content
        ?.filter((item) => item.type === 'text' && item.text !== undefined)
        .map((item) => item.text ?? '')
        .join('\n') ?? ''
    )
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('mcp client disposed'))
    }
    this.pending.clear()
    try {
      this.child?.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/shutdown',
        })}\n`,
      )
      this.child?.stdin?.end()
    } catch {
      // 管道已断。
    }
    setTimeout(() => {
      try {
        this.child?.kill()
      } catch {
        // 已退出
      }
    }, 200).unref()
    this.child = null
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.child === null) {
      return Promise.reject(new Error('mcp client not connected'))
    }
    const id = ++this.seq
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp request timeout: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`, (writeError) => {
        if (!writeError) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(
          writeError instanceof Error
            ? writeError
            : new Error(`mcp write failed: ${String(writeError)}`),
        )
      })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
      )
    } catch {
      // 管道已断,后续请求会失败。
    }
  }

  private handleLine(line: string): void {
    if (line === '') return
    let message: {
      id?: unknown
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id !== 'number') return // notification
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(message.error.message ?? 'mcp request error'))
    } else {
      entry.resolve(message.result)
    }
  }

  private rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/** spawn 用 id 关联的 request 辅助:connect 内部使用。 */
export function newRequestId(): string {
  return randomUUID()
}
