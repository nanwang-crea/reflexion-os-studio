import {
  AgentBrowserNavigateSchema,
  AgentBrowserPageSchema,
} from '@reflexion-os-studio/contracts'
import type { PlaywrightBackend } from '../worker/backend.js'
import { EmbeddedConnection } from './connection.js'
import type { HostBrowserTransport } from './host.js'

export class EmbeddedBrowserClient {
  private backend: PlaywrightBackend | null = null
  private disposed = false
  private readonly connection: EmbeddedConnection
  constructor(host: HostBrowserTransport, sessionId: string) {
    this.connection = new EmbeddedConnection(host, sessionId)
  }
  async connect(): Promise<void> {
    const { PlaywrightBackend } = await import('../worker/backend.js')
    if (this.disposed) throw new Error('browser_closed')
    this.backend = new PlaywrightBackend(
      undefined,
      undefined,
      'headed',
      undefined,
      this.connection,
    )
  }
  async callTool(
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    const backend = this.backend
    if (!backend || this.disposed) throw new Error('browser_closed')
    try {
      let result: unknown
      if (operation === 'navigate') {
        const input = AgentBrowserNavigateSchema.parse(args)
        result = await backend.navigate(input.url, input.from)
      } else if (operation === 'execute') result = await backend.execute(args)
      else if (operation === 'read')
        result = await backend.read(AgentBrowserPageSchema.parse(args))
      else if (operation === 'click' || operation === 'type')
        result = await backend.interact(operation, args)
      else throw new Error('browser_operation_failed')
      signal.throwIfAborted()
      if (this.connection.paused) throw new Error('browser_user_control')
      return JSON.stringify(result)
    } catch (error) {
      if (this.connection.paused) throw new Error('browser_user_control')
      throw error
    }
  }
  async disposeAndWait(): Promise<void> {
    this.disposed = true
    await this.backend?.close()
    await this.connection.close()
    this.backend = null
  }
}
