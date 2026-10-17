import type { EmbeddedConnection } from '../embedded/connection.js'
import { automationTarget } from './automation/targets.js'
import { executeBrowserPlan } from './automation/execute.js'
import { launchAgentBrowser } from './launch.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type Browser, type BrowserContext } from 'playwright'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectBrowserMcp } from './connection.js'
import {
  AgentBrowserPageSchema,
  BrowserPlanSchema,
  AgentBrowserClickSchema,
  AgentBrowserTypeSchema,
  isSafeAgentBrowserUrl,
  type AgentBrowserDocument,
  type AgentBrowserPage,
  type AgentBrowserDisplay,
  type AgentBrowserLaunch,
} from '@reflexion-os-studio/contracts'
import { createBrowserProxy } from '../security/proxy.js'
import { allowedRequest, publicAddress } from '../security/network.js'
import { observeBrowserPage } from './observation.js'

type Proxy = Awaited<ReturnType<typeof createBrowserProxy>>
export class PlaywrightBackend {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private proxy: Proxy | null = null
  private client: Client | null = null
  private server:
    Awaited<ReturnType<typeof connectBrowserMcp>>['server'] | null = null
  private document: AgentBrowserDocument | null = null
  private digest: string | null = null
  private readVersion: string | null = null
  private generation = 0
  private output: string | null = null
  private origin: string | null = null
  private interacting = false
  private interactionBlocked = false

  constructor(
    private readonly proxyFactory = createBrowserProxy,
    private readonly resolveAddress = publicAddress,
    private readonly display: AgentBrowserDisplay = 'headless',
    private readonly launch: AgentBrowserLaunch = {
      channel: 'chromium',
      fallbackManaged: false,
    },
    private readonly embedded?: EmbeddedConnection,
  ) {}

  async navigate(
    url: string,
    from?: AgentBrowserPage,
  ): Promise<AgentBrowserDocument> {
    if (this.embedded?.paused) throw new Error('browser_user_control')
    if (!isSafeAgentBrowserUrl(url)) throw new Error('browser_url_denied')
    if (from) await this.assertCurrent(from)
    const origin = new URL(url).origin
    if (this.origin === origin && this.embedded?.hasPage)
      await this.syncEmbedded()
    const reusable =
      this.origin === origin &&
      (this.embedded?.hasPage || this.browser?.isConnected()) &&
      this.context?.pages().some((page) => !page.isClosed()) &&
      this.client
    if (!reusable) await this.close()
    if (reusable) await this.embedded?.assertControl()
    const generation = this.generation
    this.origin = origin
    this.document = null
    this.digest = null
    this.readVersion = null
    try {
      if (!reusable) {
        await this.resolveAddress(new URL(url).hostname)
        if (generation !== this.generation) throw new Error('browser_closed')
        this.proxy = await this.proxyFactory(origin)
        if (generation !== this.generation) throw new Error('browser_closed')
        if (this.embedded) {
          const connection = await this.embedded.open(origin, this.proxy.server)
          this.browser = connection.browser
          this.context = connection.context
        } else {
          this.browser = await launchAgentBrowser(
            this.launch,
            {
              headless: this.display === 'headless',
              chromiumSandbox: true,
              proxy: { server: this.proxy.server, bypass: '<-loopback>' },
              args: [
                ...(process.platform === 'linux' &&
                this.display === 'headed' &&
                process.env.WAYLAND_DISPLAY &&
                !process.env.DISPLAY
                  ? ['--ozone-platform=wayland']
                  : []),
                '--disable-background-networking',
                '--disable-quic',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
              ],
            },
            () => generation === this.generation,
          )
          if (generation !== this.generation) throw new Error('browser_closed')
          this.context = await this.browser.newContext({
            acceptDownloads: false,
            serviceWorkers: 'block',
            permissions: [],
          })
        }
        const context = this.context
        await this.guardContext(context, origin)
        this.output = await mkdtemp(join(tmpdir(), 'reflexion-playwright-'))
        const connection = await connectBrowserMcp(context, this.output)
        this.server = connection.server
        this.client = connection.client
        if (generation !== this.generation) throw new Error('browser_closed')
      }
      if (!(this.embedded?.rebound && this.context?.pages()[0]?.url() === url))
        await this.call('browser_navigate', { url })
      if (this.embedded) this.embedded.rebound = false
      const observed = await this.observe()
      if (
        generation !== this.generation ||
        new URL(observed.sourceUrl).origin !== origin
      )
        throw new Error('browser_source_changed')
      const { digest, ...document } = observed
      this.document = {
        ...document,
        page: { tabId: randomUUID(), origin, pageVersion: randomUUID() },
      }
      this.digest = digest
      return {
        page: this.document.page,
        sourceUrl: this.document.sourceUrl,
        title: this.document.title,
        truncated: this.document.truncated,
        injectionWarning: this.document.injectionWarning,
      }
    } catch (error) {
      if (this.embedded?.paused) throw new Error('browser_user_control')
      await this.close()
      throw error
    }
  }

  async read(page: AgentBrowserPage): Promise<AgentBrowserDocument> {
    await this.assertCurrent(page)
    if (!this.document) throw new Error('browser_page_stale')
    this.readVersion = page.pageVersion
    return this.document
  }

  async interact(
    operation: 'click' | 'type',
    args: unknown,
  ): Promise<AgentBrowserDocument> {
    const typing =
      operation === 'type' ? AgentBrowserTypeSchema.parse(args) : null
    const input = typing ?? AgentBrowserClickSchema.parse(args)
    if (this.readVersion !== input.page.pageVersion)
      throw new Error('browser_page_stale')
    await this.assertCurrent(input.page)
    const browserPage = this.context?.pages()[0]
    if (!browserPage || !this.document?.snapshot)
      throw new Error('browser_page_stale')
    await automationTarget(
      browserPage,
      this.document.snapshot,
      { ref: input.ref, name: input.element },
      !!typing,
      typing?.submit ?? false,
    )
    const result = await this.execute({
      mode: 'actions',
      page: input.page,
      steps: [
        {
          action: operation,
          target: { ref: input.ref, name: input.element },
          ...(typing ? { text: typing.text, submit: typing.submit } : {}),
        },
      ],
    })
    if (result.error || !result.document)
      throw new Error(result.error ?? 'browser_interaction_failed')
    const { page, sourceUrl, title, truncated, injectionWarning } =
      result.document
    return { page, sourceUrl, title, truncated, injectionWarning }
  }

  async execute(raw: unknown) {
    const plan = BrowserPlanSchema.parse(raw)
    await this.assertCurrent(plan.page)
    const generation = this.generation
    this.interacting = true
    this.interactionBlocked = false
    try {
      return await executeBrowserPlan(plan, {
        page: () => this.context?.pages()[0],
        capture: async () => {
          await this.embedded?.assertControl()
          const { digest, ...document } = await this.observe()
          this.document = {
            ...document,
            page: {
              tabId: this.document?.page.tabId ?? plan.page.tabId,
              origin: plan.page.origin,
              pageVersion: randomUUID(),
            },
          }
          this.digest = digest
          this.readVersion = this.document.page.pageVersion
          return this.document
        },
        navigate: (url) => this.navigate(url),
        blocked: () => this.interactionBlocked,
        current: () => generation === this.generation,
        invalidate: () => {
          this.document = null
          this.digest = null
          this.readVersion = null
        },
        close: () => this.close(),
      })
    } finally {
      this.interacting = false
    }
  }

  async close(page?: AgentBrowserPage): Promise<void> {
    if (page) this.assertIdentity(page)
    ++this.generation
    this.document = null
    this.digest = null
    this.readVersion = null
    this.origin = null
    const [client, server, browser, proxy] = [
      this.client,
      this.server,
      this.browser,
      this.proxy,
    ]
    this.client = null
    this.server = null
    this.browser = null
    this.context = null
    this.proxy = null
    const output = this.output
    this.output = null
    await Promise.allSettled([
      client?.close(),
      server?.close(),
      browser?.close(),
      proxy?.close(),
      this.embedded?.close(),
    ])
    if (output) await rm(output, { recursive: true, force: true })
  }

  private async guardContext(
    context: BrowserContext,
    origin: string,
  ): Promise<void> {
    await context.route('**/*', async (route) => {
      try {
        const request = route.request()
        if (!allowedRequest(origin, request.url(), request.method())) {
          if (this.interacting) this.interactionBlocked = true
          await route.abort('blockedbyclient')
        } else await route.continue()
      } catch {
        // A handoff or cancellation can disconnect an intercepted request.
        await route.abort('blockedbyclient').catch(() => {})
      }
    })
    await context.routeWebSocket('**/*', (socket) => socket.close())
    const watch = (page: ReturnType<BrowserContext['pages']>[number]) => {
      page.on('download', (download) => void download.cancel().catch(() => {}))
    }
    for (const page of context.pages()) watch(page)
    context.on('page', (page) => {
      if (context.pages().length > 1) void page.close().catch(() => {})
      watch(page)
    })
  }
  private async syncEmbedded(): Promise<void> {
    if (!this.embedded) return
    await this.embedded.assertControl()
    const connection = this.embedded.current
    if (connection && this.browser !== connection.browser) {
      await Promise.allSettled([this.client?.close(), this.server?.close()])
      this.browser = connection.browser
      this.context = connection.context
      if (!this.origin) throw new Error('browser_closed')
      await this.guardContext(this.context, this.origin)
      if (!this.output)
        this.output = await mkdtemp(join(tmpdir(), 'reflexion-playwright-'))
      const mcp = await connectBrowserMcp(this.context, this.output)
      this.client = mcp.client
      this.server = mcp.server
      this.readVersion = null
    }
  }
  private assertIdentity(page: AgentBrowserPage): void {
    const parsed = AgentBrowserPageSchema.parse(page)
    if (
      !this.document ||
      JSON.stringify(parsed) !== JSON.stringify(this.document.page)
    )
      throw new Error('browser_page_stale')
  }
  private async assertCurrent(page: AgentBrowserPage): Promise<void> {
    await this.syncEmbedded()
    this.assertIdentity(page)
    const observed = await this.observe()
    this.assertIdentity(page)
    if (observed.digest !== this.digest) throw new Error('browser_page_stale')
  }
  private observe() {
    return observeBrowserPage(this.context, this.origin, (name, args) =>
      this.call(name, args),
    )
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) throw new Error('browser_closed')
    const result = await this.client.callTool({ name, arguments: args })
    if (result.isError || !Array.isArray(result.content))
      throw new Error('browser_operation_failed')
    return result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
  }
}
