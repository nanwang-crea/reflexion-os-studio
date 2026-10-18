import type { EmbeddedConnection } from '../embedded/connection.js'
import { executeBrowserPlan } from './automation/execute.js'
import { launchAgentBrowser } from './launch.js'
import { browserFailure } from './errors.js'
import { navigateBrowserPage } from './navigation.js'
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
import { observeBrowserPage } from './observation.js'

export class PlaywrightBackend {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private client: Client | null = null
  private server:
    Awaited<ReturnType<typeof connectBrowserMcp>>['server'] | null = null
  private document: AgentBrowserDocument | null = null
  private tabId: string | null = null
  private generation = 0
  private output: string | null = null

  constructor(
    private readonly display: AgentBrowserDisplay = 'headless',
    private readonly launch: AgentBrowserLaunch = {
      channel: 'chromium',
      fallbackManaged: false,
    },
    private readonly embedded?: EmbeddedConnection,
    private readonly launchBrowser = launchAgentBrowser,
  ) {}

  async navigate(
    url: string,
    from?: AgentBrowserPage,
  ): Promise<AgentBrowserDocument> {
    if (this.embedded?.paused) throw new Error('browser_user_control')
    if (!isSafeAgentBrowserUrl(url)) throw new Error('browser_url_denied')
    if (from) await this.assertCurrent(from)
    if (this.embedded?.hasPage) await this.syncEmbedded()
    const reusable =
      (this.embedded?.hasPage || this.browser?.isConnected()) &&
      this.context?.pages().some((page) => !page.isClosed()) &&
      this.client
    if (!reusable) await this.close()
    const generation = this.generation
    try {
      if (!reusable) {
        if (this.embedded) {
          const connection = await this.embedded.open(new URL(url).origin)
          this.browser = connection.browser
          this.context = connection.context
        } else {
          this.browser = await this.launchBrowser(
            this.launch,
            {
              headless: this.display === 'headless',
              chromiumSandbox: true,
              args: [
                ...(process.platform === 'linux' &&
                this.display === 'headed' &&
                process.env.WAYLAND_DISPLAY &&
                !process.env.DISPLAY
                  ? ['--ozone-platform=wayland']
                  : []),
                '--disable-background-networking',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
              ],
            },
            () => generation === this.generation,
          )
          if (generation !== this.generation) throw new Error('browser_closed')
          this.context = await this.browser.newContext({
            acceptDownloads: false,
            permissions: [],
          })
        }
        this.tabId = randomUUID()
        this.watchContext(this.context)
        this.output = await mkdtemp(join(tmpdir(), 'reflexion-playwright-'))
        const connection = await connectBrowserMcp(this.context, this.output)
        this.server = connection.server
        this.client = connection.client
      }
      if (generation !== this.generation) throw new Error('browser_closed')
      if (!(this.embedded?.rebound && this.context?.pages()[0]?.url() === url))
        await navigateBrowserPage(this.context!, url)
      if (this.embedded) this.embedded.rebound = false
      const document = await this.capture()
      if (generation !== this.generation) throw new Error('browser_closed')
      return this.metadata(document)
    } catch (error) {
      if (this.embedded?.paused) throw new Error('browser_user_control')
      // A failed navigation does not destroy a recoverable tab or its session.
      if (!this.context?.pages().some((page) => !page.isClosed()))
        await this.close()
      throw browserFailure(error)
    }
  }

  async read(page: AgentBrowserPage): Promise<AgentBrowserDocument> {
    await this.assertCurrent(page)
    return this.capture()
  }

  async interact(
    operation: 'click' | 'type',
    args: unknown,
  ): Promise<AgentBrowserDocument> {
    const typing =
      operation === 'type' ? AgentBrowserTypeSchema.parse(args) : null
    const input = typing ?? AgentBrowserClickSchema.parse(args)
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
    return this.metadata(result.document)
  }

  async execute(raw: unknown) {
    const plan = BrowserPlanSchema.parse(raw)
    await this.assertCurrent(plan.page)
    // AX references belong to the observed document, not a later navigation.
    const hasRef = plan.steps.some(
      (step) =>
        ('target' in step && step.target && 'ref' in step.target) ||
        ('source' in step && 'ref' in step.source),
    )
    if (
      hasRef &&
      (plan.page.pageVersion !== this.document?.page.pageVersion ||
        this.document?.sourceUrl !== this.context?.pages()[0]?.url())
    )
      throw new Error('browser_page_stale')
    const generation = this.generation
    return executeBrowserPlan(plan, {
      page: () => this.context?.pages()[0],
      capture: () => this.capture(),
      navigate: (url) => this.navigate(url),
      blocked: () => false,
      current: () => generation === this.generation && !this.embedded?.paused,
      // Keep tab ownership and the last observation for read-based recovery.
      invalidate: () => {},
      close: () => this.close(),
    })
  }

  async close(page?: AgentBrowserPage): Promise<void> {
    if (page) this.assertIdentity(page)
    ++this.generation
    this.document = null
    this.tabId = null
    const [client, server, browser] = [this.client, this.server, this.browser]
    this.client = null
    this.server = null
    this.browser = null
    this.context = null
    const output = this.output
    this.output = null
    await Promise.allSettled([
      client?.close(),
      server?.close(),
      browser?.close(),
      this.embedded?.close(),
    ])
    if (output) await rm(output, { recursive: true, force: true })
  }

  private watchContext(context: BrowserContext): void {
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
      this.watchContext(this.context)
      if (!this.output)
        this.output = await mkdtemp(join(tmpdir(), 'reflexion-playwright-'))
      const mcp = await connectBrowserMcp(this.context, this.output)
      this.client = mcp.client
      this.server = mcp.server
    }
  }
  private assertIdentity(page: AgentBrowserPage): void {
    if (AgentBrowserPageSchema.parse(page).tabId !== this.tabId)
      throw new Error('browser_page_stale')
  }
  private async assertCurrent(page: AgentBrowserPage): Promise<void> {
    await this.syncEmbedded()
    this.assertIdentity(page)
    if (!this.context?.pages().some((page) => !page.isClosed()))
      throw new Error('browser_closed')
  }
  private async capture(): Promise<AgentBrowserDocument> {
    await this.embedded?.assertControl()
    const generation = this.generation
    const document = await observeBrowserPage(this.context, (name, args) =>
      this.call(name, args),
    )
    if (!this.tabId || generation !== this.generation)
      throw new Error('browser_closed')
    this.document = {
      ...document,
      page: {
        tabId: this.tabId,
        origin: new URL(document.sourceUrl).origin,
        pageVersion: randomUUID(),
      },
    }
    return this.document
  }
  private metadata(document: AgentBrowserDocument): AgentBrowserDocument {
    const metadata = { ...document }
    delete metadata.snapshot
    return metadata
  }
  private async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.client) throw new Error('browser_closed')
    const result = await this.client.callTool({ name, arguments: args })
    if (!Array.isArray(result.content))
      throw new Error('browser_response_invalid')
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    if (result.isError) throw browserFailure(text)
    return text
  }
}
