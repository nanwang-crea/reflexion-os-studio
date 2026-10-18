import type { BrowserContext } from 'playwright'
import { isSafeAgentBrowserUrl } from '@reflexion-os-studio/contracts'
import { prepareBrowserContent, snapshotSection } from '../security/content.js'

/** A read refreshes a live page; DOM changes do not invalidate its tab identity. */
export async function observeBrowserPage(
  context: BrowserContext | null,
  invoke: (name: string, args: Record<string, unknown>) => Promise<string>,
) {
  const page = context?.pages()[0]
  if (!page || page.isClosed()) throw new Error('browser_closed')
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .waitForLoadState('domcontentloaded', { timeout: 2000 })
      .catch(() => {})
    const before = page.url()
    if (!isSafeAgentBrowserUrl(before))
      throw new Error('browser_page_unavailable')
    let result: string
    try {
      result = await invoke('browser_snapshot', {})
    } catch (error) {
      if (
        attempt < 2 &&
        error instanceof Error &&
        ['browser_page_loading', 'browser_navigation_failed'].includes(
          error.message,
        )
      )
        continue
      throw error
    }
    const sourceUrl = page.url()
    if (sourceUrl !== before) continue
    const title = await page.title()
    if (page.url() !== sourceUrl) continue
    return {
      ...prepareBrowserContent(title, snapshotSection(result)),
      sourceUrl,
    }
  }
  throw new Error('browser_page_loading')
}
