import { launchAgentBrowser } from './launch.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createConnection } from '@playwright/mcp'
import { type Browser, type BrowserContext } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  AgentBrowserPageSchema,
  isSafeAgentBrowserUrl,
  type AgentBrowserDocument,
  type AgentBrowserPage,
  type AgentBrowserDisplay,
  type AgentBrowserLaunch,
} from '@reflexion-os-studio/contracts'
import { createBrowserProxy } from '../security/proxy.js'
import { allowedRequest, publicAddress } from '../security/network.js'
import { filterBrowserContent, snapshotSection } from '../security/content.js'

type Proxy = Awaited<ReturnType<typeof createBrowserProxy>>
export class PlaywrightBackend {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private proxy: Proxy | null = null
  private client: Client | null = null
  private server: Awaited<ReturnType<typeof createConnection>> | null = null
  private document: AgentBrowserDocument | null = null
  private digest: string | null = null
  private generation = 0
  private output: string | null = null
  private origin: string | null = null

  constructor(
    private readonly proxyFactory = createBrowserProxy,
    private readonly resolveAddress = publicAddress,
    private readonly display: AgentBrowserDisplay = 'headless',
    private readonly launch: AgentBrowserLaunch = {
      channel: 'chromium',
      fallbackManaged: false,
    },
  ) {}

  async navigate(
    url: string,
    from?: AgentBrowserPage,
  ): Promise<AgentBrowserDocument> {
    if (!isSafeAgentBrowserUrl(url)) throw new Error('browser_url_denied')
    if (from) await this.assertCurrent(from)
    await this.close()
    const generation = this.generation
    const origin = new URL(url).origin
    this.origin = origin
    try {
      await this.resolveAddress(new URL(url).hostname)
      if (generation !== this.generation) throw new Error('browser_closed')
      this.proxy = await this.proxyFactory(origin)
      if (generation !== this.generation) throw new Error('browser_closed')
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
      const context = this.context
      await context.route('**/*', async (route) => {
        const request = route.request()
        if (!allowedRequest(origin, request.url(), request.method()))
          await route.abort('blockedbyclient')
        else await route.continue()
      })
      await context.routeWebSocket('**/*', (socket) => socket.close())
      context.on('page', (page) => {
        if (context.pages().length > 1) void page.close().catch(() => {})
        page.on(
          'download',
          (download) => void download.cancel().catch(() => {}),
        )
      })
      this.output = await mkdtemp(join(tmpdir(), 'reflexion-playwright-'))
      this.server = await createConnection(
        {
          // Use the supplied isolated context; MCP must not create another one.
          browser: { browserName: 'chromium', isolated: false },
          capabilities: ['core'],
          webmcp: false,
          outputDir: this.output,
          saveSession: false,
          imageResponses: 'omit',
          codegen: 'none',
          snapshot: { mode: 'none' },
          timeouts: { navigation: 15000, action: 5000 },
        },
        async () => context,
      )
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      this.client = new Client({ name: 'reflexion-browser', version: '1' })
      await this.server.connect(serverTransport)
      await this.client.connect(clientTransport)
      await this.call('browser_navigate', { url })
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
      await this.close()
      throw error
    }
  }

  async read(page: AgentBrowserPage): Promise<AgentBrowserDocument> {
    await this.assertCurrent(page)
    if (!this.document) throw new Error('browser_page_stale')
    return this.document
  }

  async close(page?: AgentBrowserPage): Promise<void> {
    if (page) this.assertIdentity(page)
    ++this.generation
    this.document = null
    this.digest = null
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
    ])
    if (output) await rm(output, { recursive: true, force: true })
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
    this.assertIdentity(page)
    const observed = await this.observe()
    this.assertIdentity(page)
    if (observed.digest !== this.digest) throw new Error('browser_page_stale')
  }
  private async observe() {
    const page = this.context?.pages()[0]
    if (!page || page.isClosed()) throw new Error('browser_page_stale')
    const before = page.url()
    if (
      !isSafeAgentBrowserUrl(before) ||
      new URL(before).origin !== this.origin
    )
      throw new Error('browser_page_stale')
    for (const frame of page.frames()) {
      if (await frame.locator('input[type="password"]').count())
        throw new Error('browser_sensitive_content')
    }
    const result = await this.call('browser_snapshot', {})
    const sourceUrl = page.url()
    if (sourceUrl !== before || !isSafeAgentBrowserUrl(sourceUrl))
      throw new Error('browser_page_stale')
    const snapshot = snapshotSection(result)
    const title = await page.title()
    const content = filterBrowserContent(title, snapshot)
    return {
      ...content,
      sourceUrl,
      digest: fingerprint({ sourceUrl, title, snapshot }),
    }
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
function fingerprint(document: {
  sourceUrl: string
  title: string
  snapshot: string
}): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex')
}
