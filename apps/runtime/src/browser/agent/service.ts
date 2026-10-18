import { EmbeddedBrowserClient } from './embedded/client.js'
import type { HostBrowserTransport } from './embedded/host.js'
type BrowserClient = Pick<McpClient, 'connect' | 'callTool' | 'disposeAndWait'>
import { validateExecutionResult } from './automation/validate-result.js'
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

export class BrowserAgentService {
  readonly runtime: BrowserRuntimeService
  private readonly clients = new Map<
    string,
    { sessionId: string; client: BrowserClient; page: AgentBrowserPage | null }
  >()
  private readonly retained = new Map<
    string,
    {
      sessionId: string
      client: BrowserClient
      page: AgentBrowserPage | null
    }
  >()
  private epoch = 0
  private readonly cleanup = new Set<Promise<void>>()
  constructor(
    private readonly store: Store,
    private readonly createClient = (
      display: AgentBrowserDisplay,
      sessionId: string,
    ): BrowserClient => {
      if (this.host) return new EmbeddedBrowserClient(this.host, sessionId)
      const { launch, browsers } = this.runtime.resolveLaunch(
        this.store.browserSettings.get().agentBrowserSource ?? 'auto',
      )
      const paths = browserWorkerPaths()
      return new McpClient({
        command: process.execPath,
        args: [
          '--disable-warning=ExperimentalWarning',
          paths.worker,
          `--display=${display}`,
          `--launch=${JSON.stringify(launch)}`,
        ],
        env: browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {},
        managed: true,
      })
    },
    runtime?: BrowserRuntimeService,
    private readonly host?: HostBrowserTransport,
  ) {
    this.runtime = runtime ?? new BrowserRuntimeService(store.dataDir)
    if (host) this.runtime.useEmbedded()
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
    if (
      !['navigate', 'read', 'close', 'click', 'type', 'execute'].includes(
        operation,
      )
    )
      throw new Error('browser_operation_failed')
    if (!this.enabled) throw new Error('browser_disabled')
    signal.throwIfAborted()
    const epoch = this.epoch
    const active = this.clients.get(runId)
    let entry = active ?? this.retained.get(sessionId)
    if (entry && entry.sessionId !== sessionId)
      throw new Error('browser_page_stale')
    if (operation !== 'navigate' || args.from) {
      const page = AgentBrowserPageSchema.parse(
        operation === 'navigate'
          ? args.from
          : operation === 'click' ||
              operation === 'type' ||
              operation === 'execute'
            ? args.page
            : args,
      )
      if (!entry?.page || page.tabId !== entry.page.tabId)
        throw new Error('browser_page_stale')
    }
    if (entry && !active) {
      this.retained.delete(sessionId)
      this.clients.set(runId, entry)
    }
    if (!entry) {
      if (this.clients.size + this.retained.size >= 8)
        throw new Error('browser_capacity')
      const client = this.createClient(
        this.store.browserSettings.get().agentBrowserDisplay,
        sessionId,
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
      if (operation === 'execute') {
        const result = validateExecutionResult(args, current.page, raw)
        current.page = result.document?.page ?? current.page
        if (result.error === 'browser_plan_timeout') this.release(runId)
        return result
      }
      const document = AgentBrowserDocumentSchema.parse(JSON.parse(raw))
      if (document.page.origin !== new URL(document.sourceUrl).origin)
        throw new Error('browser_response_invalid')
      if (
        operation !== 'navigate' &&
        current.page &&
        document.page.tabId !== current.page.tabId
      )
        throw new Error('browser_response_invalid')
      if (operation === 'read' && document.snapshot === undefined)
        throw new Error('browser_response_invalid')
      if (
        (operation === 'click' || operation === 'type') &&
        document.page.pageVersion === current.page?.pageVersion
      )
        throw new Error('browser_response_invalid')
      if (operation !== 'read' && document.snapshot !== undefined)
        throw new Error('browser_response_invalid')
      current.page = document.page
      return document
    } catch (error) {
      const fatal =
        error instanceof Error &&
        [
          'browser_closed',
          'browser_unavailable',
          'browser_disabled',
          'browser_response_invalid',
          'browser_plan_timeout',
        ].includes(error.message)
      if (fatal || signal.aborted) this.release(runId)
      if (signal.aborted)
        throw new DOMException('The operation was aborted.', 'AbortError')
      const code = error instanceof Error ? error.message : ''
      if (/^browser_[a-z_]+$/.test(code)) throw error
      throw new Error('browser_operation_failed')
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  finishRun(runId: string, cancelled = false): void {
    const entry = this.clients.get(runId)
    if (!entry) return
    if (
      cancelled ||
      !this.enabled ||
      this.store.browserSettings.get().agentBrowserLifetime !== 'session'
    ) {
      this.release(runId)
      return
    }
    this.clients.delete(runId)
    const previous = this.retained.get(entry.sessionId)
    if (previous && previous !== entry) this.disposeClient(previous.client)
    this.retained.set(entry.sessionId, entry)
  }
  releaseSession(sessionId: string): void {
    // Deleting a root conversation also cascades its internal child sessions.
    const removed = (id: string) =>
      id === sessionId || !this.store.sessions.get(id)
    for (const [id, entry] of this.retained) {
      if (removed(id)) {
        this.retained.delete(id)
        this.disposeClient(entry.client)
      }
    }
    for (const [runId, entry] of this.clients) {
      if (removed(entry.sessionId)) this.release(runId)
    }
  }
  release(runId: string): void {
    const entry = this.clients.get(runId)
    this.clients.delete(runId)
    if (entry) this.disposeClient(entry.client)
  }
  private disposeClient(client: BrowserClient): void {
    const promise = client.disposeAndWait().catch(() => {})
    this.cleanup.add(promise)
    void promise.finally(() => this.cleanup.delete(promise))
  }
  async closeAll(): Promise<void> {
    this.revoke()
    await Promise.all(this.cleanup)
  }
  async shutdown(): Promise<void> {
    this.revoke()
    await this.runtime.shutdown()
    await Promise.all(this.cleanup)
  }
  revoke(): void {
    ++this.epoch
    for (const runId of this.clients.keys()) this.release(runId)
    for (const entry of this.retained.values()) this.disposeClient(entry.client)
    this.retained.clear()
  }
}
