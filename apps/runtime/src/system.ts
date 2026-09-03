import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  PROTOCOL_VERSION,
  ReadyParamsSchema,
} from '@reflexion-os-studio/contracts'

export type SystemAvailability =
  'starting' | 'ready' | 'degraded' | 'unavailable' | 'stopped'

const HANDSHAKE_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const SHUTDOWN_GRACE_MS = 2_000
/** 崩溃重启策略：有限次数 + 退避；耗尽后保持 degraded 直到 Runtime 重启。 */
const MAX_RESTARTS = 3
const RESTART_BACKOFF_MS = [500, 1_000, 2_000]

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Rust System Runtime 的 TS 侧拥有者（方案 A）：
 * 负责 spawn、握手、按 id 关联的请求、状态上报、有限重启与协议关停。
 * Rust 不可用只降级（工具不可用），绝不阻塞 Chat。
 */
export class SystemRuntimeClient {
  private child: ReturnType<typeof spawn> | null = null
  private pending = new Map<string | number, PendingRequest>()
  private seq = 0
  private handshakeTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stopping = false
  private restarts = 0
  private status: SystemAvailability = 'starting'
  /** 当前子进程代际：error/exit 事件可能重复触发，用代际防止双重重启调度。 */
  private generation = 0

  constructor(
    private readonly binaryPath: string | null,
    private readonly binaryArgs: string[],
    private readonly onStatusChange: (
      status: SystemAvailability,
      detail?: string,
    ) => void,
  ) {}

  get available(): boolean {
    return this.status === 'ready'
  }

  get currentStatus(): SystemAvailability {
    return this.status
  }

  start(): void {
    if (this.binaryPath === null) {
      this.setStatus('unavailable', 'Rust System Runtime binary not found')
      return
    }
    this.spawnChild()
  }

  /** 发起一次 JSON-RPC 请求；仅在 ready 状态可用。signal 中止时本地失败并向 Rust 发 system.cancel。 */
  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.status !== 'ready' || this.child === null) {
      throw new Error(`system runtime not available (${this.status})`)
    }
    const id = ++this.seq
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`system request timeout: ${method}`))
      }, options?.timeoutMs ?? REQUEST_TIMEOUT_MS)
      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        // Rust 主循环可能正被长命令占用：cancel 通知由其 stdin 顺序处理，
        // 对运行中的 shell 按请求 id 杀进程树。
        try {
          this.child?.stdin?.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'system.cancel',
              params: { requestId: id },
            })}\n`,
          )
        } catch {
          // 管道已断：进程退出路径会统一收尾。
        }
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (options?.signal?.aborted) {
        onAbort()
        return
      }
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          options?.signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          options?.signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`, (writeError) => {
        if (!writeError) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new Error(`system request failed: ${writeError.message}`))
      })
    })
  }

  /** 协议关停：system.shutdown → 宽限等待 → 兜底 kill；进程退出后置 stopped。 */
  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    const child = this.child
    if (!child || this.status === 'stopped' || this.status === 'unavailable') {
      this.rejectPending(new Error('system runtime stopped'))
      this.setStatus('stopped')
      return
    }
    await new Promise<void>((resolve) => {
      const exitListener = (): void => resolve()
      child.once('exit', exitListener)
      try {
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'system.shutdown' })}\n`,
        )
      } catch {
        // 写失败直接走 kill 兜底。
      }
      setTimeout(() => {
        child.off('exit', exitListener)
        try {
          child.kill()
        } catch {
          // 进程已退出
        }
        resolve()
      }, SHUTDOWN_GRACE_MS)
    })
    this.rejectPending(new Error('system runtime stopped'))
    this.setStatus('stopped')
  }

  private spawnChild(): void {
    if (this.binaryPath === null) return
    this.setStatus('starting')
    const generation = ++this.generation
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.binaryPath, this.binaryArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.onUnexpectedExit(`spawn failed: ${String(error)}`, generation)
      return
    }
    if (!child.stdout || !child.stdin) {
      this.onUnexpectedExit('spawn produced no stdio pipes', generation)
      return
    }
    this.child = child

    this.handshakeTimer = setTimeout(() => {
      if (this.status !== 'starting' || generation !== this.generation) return
      // 握手超时：杀掉当前进程，exit 路径统一进入 degraded + 重启。
      try {
        child.kill()
      } catch {
        // 进程已退出
      }
    }, HANDSHAKE_TIMEOUT_MS)

    const readline = createInterface({ input: child.stdout })
    readline.on('line', (line) => {
      this.handleLine(line.trim())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[system] ${chunk.toString()}`)
    })
    child.on('error', (error) => {
      this.onUnexpectedExit(`spawn error: ${error.message}`, generation)
    })
    child.on('exit', (code, signal) => {
      readline.close()
      if (generation !== this.generation || this.stopping) return
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
      }
      this.child = null
      this.onUnexpectedExit(
        `system runtime exited (code=${String(code)} signal=${String(signal)})`,
        generation,
      )
    })
  }

  private handleLine(line: string): void {
    if (line === '') return
    let message: {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(`[runtime] system protocol parse error: ${line}\n`)
      return
    }
    if (message.method === 'system.ready') {
      this.clearHandshakeTimer()
      const parsed = ReadyParamsSchema.safeParse(message.params)
      // 握手严格校验 protocolVersion；不一致/畸形不允许进入 ready。
      // 视为无效握手：杀掉进程走 exit 统一路径（degraded + 有限重启），而不是误标记 ready。
      if (!parsed.success || parsed.data.protocolVersion !== PROTOCOL_VERSION) {
        process.stderr.write(
          `[runtime] system.ready rejected: expected protocol ${PROTOCOL_VERSION}, ` +
            `got ${String((message.params as { protocolVersion?: unknown })?.protocolVersion)} ` +
            `(${parsed.success ? 'version mismatch' : 'malformed params'})\n`,
        )
        try {
          this.child?.kill()
        } catch {
          // 进程已退出：exit 路径会统一收尾。
        }
        return
      }
      // 重新协商成功：重置重启预算，避免历史崩溃累计导致后续无谓降级。
      this.restarts = 0
      this.setStatus('ready', parsed.data.runtimeVersion)
      return
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string') &&
      this.pending.has(message.id)
    ) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(message.error.message ?? 'system request error'))
      } else {
        entry.resolve(message.result)
      }
    }
  }

  private onUnexpectedExit(detail: string, generation: number): void {
    if (generation !== this.generation) return
    this.rejectPending(new Error(detail))
    this.child = null
    this.setStatus('degraded', detail)
    if (this.restarts >= MAX_RESTARTS) {
      process.stderr.write(
        '[runtime] system runtime restart budget exhausted; staying degraded\n',
      )
      return
    }
    const delay =
      RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]
    this.restarts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      process.stderr.write(
        `[runtime] restarting system runtime (attempt ${this.restarts}/${MAX_RESTARTS})\n`,
      )
      this.spawnChild()
    }, delay)
  }

  private setStatus(status: SystemAvailability, detail?: string): void {
    if (this.status === status) return
    this.status = status
    this.onStatusChange(status, detail)
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
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

/**
 * Rust 二进制解析：env（宿主交接）优先，其次按 cwd 相对路径搜索（开发/CLI 场景）。
 * 找不到返回 null → 工具降级，Chat 不受影响。
 */
export function resolveSystemRuntimeBinary(): string | null {
  const fromEnv = process.env.REFLEXION_SYSTEM_RUNTIME_BIN
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) {
    return fromEnv
  }
  const candidates = [
    'target/debug',
    'crates/target/debug',
    'target/release',
    'crates/target/release',
  ]
  for (const dir of candidates) {
    for (const name of [
      'reflexion-system-runtime',
      'reflexion-system-runtime.exe',
    ]) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}
