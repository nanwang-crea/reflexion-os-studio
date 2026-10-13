import { BrowserRuntimeService } from './runtime/service.js'
import {
  AgentBrowserDocumentSchema,
  AgentBrowserPageSchema,
  type AgentBrowserPage,
  type AgentBrowserDisplay,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { McpClient } from '../../mcp/client.js'
import { browserWorkerPaths } from './paths.js'
import { filterBrowserContent } from './security/content.js'

export class BrowserAgentService {
  readonly runtime: BrowserRuntimeService
  private readonly clients = new Map<
    string,
    { sessionId: string; client: McpClient; page: AgentBrowserPage | null }
  >()
  private epoch = 0
  private readonly cleanup = new Set<Promise<void>>()
  constructor(
    private readonly store: Store,
    private readonly createClient = (display: AgentBrowserDisplay) => {
      const browsers = this.runtime.requireInstalled()
      const paths = browserWorkerPaths()
      return new McpClient({
        command: process.execPath,
        args: [
          '--disable-warning=ExperimentalWarning',
          paths.worker,
          `--display=${display}`,
        ],
        env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
        managed: true,
      })
    },
  ) {
    this.runtime = new BrowserRuntimeService(store.dataDir)
  }
  get enabled(): boolean {
    return this.store.browserSettings.get().agentBrowserEnabled
  }
  async call(
    sessionId: string,
    runId: string,
    operation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    if (!['navigate', 'read', 'close'].includes(operation))
      throw new Error('browser_operation_failed')
    if (!this.enabled) throw new Error('browser_disabled')
    signal.throwIfAborted()
    const epoch = this.epoch
    let entry = this.clients.get(runId)
    if (entry && entry.sessionId !== sessionId)
      throw new Error('browser_page_stale')
    if (operation !== 'navigate' || args.from) {
      const page = AgentBrowserPageSchema.parse(
        operation === 'navigate' ? args.from : args,
      )
      if (!entry?.page || JSON.stringify(page) !== JSON.stringify(entry.page))
        throw new Error('browser_page_stale')
    }
    if (!entry) {
      if (this.clients.size >= 8) throw new Error('browser_capacity')
      const client = this.createClient(
        this.store.browserSettings.get().agentBrowserDisplay,
      )
      entry = { sessionId, client, page: null }
      this.clients.set(runId, entry)
      const abortConnect = () => this.release(runId)
      signal.addEventListener('abort', abortConnect, { once: true })
      try {
        signal.throwIfAborted()
        await client.connect()
        signal.throwIfAborted()
      } catch {
        this.release(runId)
        if (signal.aborted)
          throw new DOMException('The operation was aborted.', 'AbortError')
        throw new Error('browser_unavailable')
      } finally {
        signal.removeEventListener('abort', abortConnect)
      }
    }
    const current = entry
    const abort = () => this.release(runId)
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (
        !this.enabled ||
        epoch !== this.epoch ||
        this.clients.get(runId) !== current
      )
        throw new Error('browser_disabled')
      signal.throwIfAborted()
      if (operation === 'close') {
        this.release(runId)
        return { closed: true }
      }
      const raw = await current.client.callTool(operation, args, signal)
      if (
        signal.aborted ||
        !this.enabled ||
        epoch !== this.epoch ||
        this.clients.get(runId) !== current
      )
        throw new Error('browser_disabled')
      const document = AgentBrowserDocumentSchema.parse(JSON.parse(raw))
      const target =
        operation === 'navigate'
          ? new URL(String(args.url)).origin
          : current.page?.origin
      if (
        document.page.origin !== target ||
        new URL(document.sourceUrl).origin !== target
      )
        throw new Error('browser_response_invalid')
      if (operation === 'read' && document.snapshot === undefined)
        throw new Error('browser_response_invalid')
      filterBrowserContent(document.title, document.snapshot ?? '')
      if (
        operation === 'read' &&
        JSON.stringify(document.page) !== JSON.stringify(current.page)
      )
        throw new Error('browser_page_stale')
      if (operation === 'navigate' && document.snapshot !== undefined)
        throw new Error('browser_response_invalid')
      current.page = document.page
      return document
    } catch (error) {
      this.release(runId)
      if (signal.aborted)
        throw new DOMException('The operation was aborted.', 'AbortError')
      const code = error instanceof Error ? error.message : ''
      if (/^browser_[a-z_]+$/.test(code)) throw error
      throw new Error('browser_operation_failed')
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  release(runId: string): void {
    const entry = this.clients.get(runId)
    this.clients.delete(runId)
    if (entry) {
      const promise = entry.client.disposeAndWait().catch(() => {})
      this.cleanup.add(promise)
      void promise.finally(() => this.cleanup.delete(promise))
    }
  }
  async shutdown(): Promise<void> {
    this.revoke()
    await this.runtime.shutdown()
    await Promise.all(this.cleanup)
  }
  revoke(): void {
    ++this.epoch
    for (const runId of this.clients.keys()) this.release(runId)
  }
}
