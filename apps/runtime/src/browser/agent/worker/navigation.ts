import type { BrowserContext } from 'playwright'

/** Retain the owned tab and let an error-page commit finish before returning. */
export async function navigateBrowserPage(
  context: BrowserContext,
  url: string,
) {
  const page = context.pages()[0] ?? (await context.newPage())
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
  } catch (error) {
    // Chromium can report a network failure before its error document commits.
    // This waits for that in-flight transition; it never replays navigation.
    await page
      .waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 500,
      })
      .catch(() => {})
    await page
      .waitForLoadState('domcontentloaded', { timeout: 500 })
      .catch(() => {})
    throw error
  }
}
