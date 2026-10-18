import type { BrowserContext } from 'playwright'
import { createHash } from 'node:crypto'
import { isSafeAgentBrowserUrl } from '@reflexion-os-studio/contracts'
import { prepareBrowserContent, snapshotSection } from '../security/content.js'

export async function observeBrowserPage(
  context: BrowserContext | null,
  origin: string | null,
  invoke: (name: string, args: Record<string, unknown>) => Promise<string>,
) {
  const page = context?.pages()[0]
  if (!page || page.isClosed()) throw new Error('browser_page_stale')
  const before = page.url()
  if (!isSafeAgentBrowserUrl(before) || new URL(before).origin !== origin)
    throw new Error('browser_page_stale')
  const result = await invoke('browser_snapshot', {})
  const sourceUrl = page.url()
  if (sourceUrl !== before || !isSafeAgentBrowserUrl(sourceUrl))
    throw new Error('browser_page_stale')
  const snapshot = snapshotSection(result)
  const title = await page.title()
  const content = prepareBrowserContent(title, snapshot)
  return {
    ...content,
    sourceUrl,
    digest: fingerprint({ sourceUrl, title, snapshot }),
  }
}

function fingerprint(document: {
  sourceUrl: string
  title: string
  snapshot: string
}): string {
  return createHash('sha256').update(JSON.stringify(document)).digest('hex')
}
