import type { Browser, BrowserContext, Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { HostBrowserLeaseSchema } from '@reflexion-os-studio/contracts'
import type { HostBrowserTransport } from './host.js'

/** MCP sees only the leased page, never sibling sessions or user tabs. */
export function scopedContext(
  context: BrowserContext,
  page: Page,
): BrowserContext {
  const scoped = new Proxy(context, {
    get(target, property) {
      if (property === 'pages') return () => (page.isClosed() ? [] : [page])
      if (property === 'newPage')
        return async () => {
          if (page.isClosed()) throw new Error('browser_closed')
          return page
        }
      if (
        [
          'addInitScript',
          'exposeBinding',
          'exposeFunction',
          'setDefaultTimeout',
          'setDefaultNavigationTimeout',
        ].includes(String(property))
      ) {
        const method = Reflect.get(page, property, page)
        return method.bind(page)
      }
      if (
        [
          'addCookies',
          'clearCookies',
          'cookies',
          'storageState',
          'grantPermissions',
          'clearPermissions',
          'request',
        ].includes(String(property))
      )
        return () => {
          throw new Error('browser_operation_failed')
        }
      if (property === 'route') return page.route.bind(page)
      if (property === 'routeWebSocket') return page.routeWebSocket.bind(page)
      if (property === 'close') return page.close.bind(page)
      if (property === 'on' || property === 'once')
        return (event: string, callback: (...args: unknown[]) => void) => {
          if (event === 'page') return scoped
          if (event === 'close') {
            page.once('close', () => callback())
            return scoped
          }
          return scoped
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return scoped
}
export class EmbeddedConnection {
  private lease: string | null = null
  private browser: Browser | null = null
  private targetId: string | null = null
  private endpoint: string | null = null
  private marker: string | null = null
  private context: BrowserContext | null = null
  private unsubscribe: (() => void) | null = null
  paused = false
  rebound = false
  get hasPage(): boolean {
    return this.lease !== null
  }
  get current(): { browser: Browser; context: BrowserContext } | null {
    return this.browser && this.context
      ? { browser: this.browser, context: this.context }
      : null
  }
  constructor(
    private readonly host: HostBrowserTransport,
    private readonly sessionId: string,
  ) {}
  async open(
    origin: string,
    proxy: string,
  ): Promise<{ browser: Browser; context: BrowserContext }> {
    const lease = randomUUID()
    this.lease = lease
    this.paused = false
    this.rebound = false
    this.unsubscribe = this.host.onControl((id, paused) => {
      if (id !== this.lease) return
      this.paused = paused
      if (paused) {
        const browser = this.browser
        this.browser = null
        this.context = null
        void browser?.close().catch(() => {})
      }
    })
    try {
      const result = HostBrowserLeaseSchema.parse(
        await this.host.request({
          kind: 'open',
          lease,
          sessionId: this.sessionId,
          origin,
          proxy,
        }),
      )
      this.endpoint = result.endpoint
      this.marker = result.marker
      if (this.paused) throw new Error('browser_user_control')
      if (this.lease !== lease) throw new Error('browser_closed')
      const { chromium } = await import('playwright')
      const browser = await chromium.connectOverCDP(result.endpoint, {
        noDefaults: true,
        timeout: 10000,
      })
      this.browser = browser
      let page: Page | undefined
      for (let attempt = 0; attempt < 200; attempt++) {
        if (this.paused || this.lease !== lease) break
        page = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((page) => page.url() === result.marker)
        if (page) break
        await setTimeout(25)
      }
      if (this.paused) throw new Error('browser_user_control')
      if (!page || this.lease !== lease) throw new Error('browser_closed')
      const session = await page.context().newCDPSession(page)
      this.targetId = (
        await session.send('Target.getTargetInfo')
      ).targetInfo.targetId
      await session.detach()
      page.on('popup', (popup) => void popup.close().catch(() => {}))
      this.context = scopedContext(page.context(), page)
      await this.host.request({ kind: 'check', lease })
      return { browser, context: this.context }
    } catch (cause) {
      if (this.paused) throw new Error('browser_user_control')
      await this.close()
      throw new Error('browser_unavailable', { cause })
    }
  }
  async assertControl(): Promise<void> {
    if (!this.lease) throw new Error('browser_closed')
    await this.host.request({ kind: 'check', lease: this.lease })
    if (!this.browser?.isConnected()) {
      if (!this.endpoint || (!this.targetId && !this.marker))
        throw new Error('browser_closed')
      const { chromium } = await import('playwright')
      const browser = await chromium.connectOverCDP(this.endpoint, {
        noDefaults: true,
        timeout: 10000,
      })
      let owned: Page | undefined
      for (const page of browser
        .contexts()
        .flatMap((context) => context.pages())) {
        const session = await page.context().newCDPSession(page)
        const id = (await session.send('Target.getTargetInfo')).targetInfo
          .targetId
        await session.detach()
        if (
          id === this.targetId ||
          (!this.targetId && page.url() === this.marker)
        ) {
          this.targetId = id
          owned = page
          break
        }
      }
      if (!owned || this.paused) {
        await browser.close()
        throw new Error('browser_user_control')
      }
      this.browser = browser
      this.context = scopedContext(owned.context(), owned)
      this.rebound = true
    }
  }
  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.targetId = null
    this.endpoint = null
    this.marker = null
    this.context = null
    const lease = this.lease
    this.lease = null
    const browser = this.browser
    this.browser = null
    // For connectOverCDP, Browser.close disconnects its transport, not the host engine.
    await Promise.allSettled([
      browser?.close(),
      lease ? this.host.request({ kind: 'close', lease }) : Promise.resolve(),
    ])
  }
}
