import type { Page } from 'playwright'
import { BrowserCapturedImageSchema } from '@reflexion-os-studio/contracts'

/** Capture the isolated website only; never the desktop, disk or other tabs. */
export async function captureBrowserImage(page: Page, fullPage: boolean) {
  if (fullPage) {
    const { width, height } = await page
      .locator('html')
      .evaluate((element) => ({
        width: Math.max(element.scrollWidth, element.clientWidth),
        height: Math.max(element.scrollHeight, element.clientHeight),
      }))
    if (width > 8000 || height > 16000 || width * height > 32000000)
      throw new Error('browser_interaction_denied')
  }
  const image = await page.screenshot({
    type: 'jpeg',
    quality: 70,
    fullPage,
    scale: 'css',
    timeout: 5000,
    // Mask every editable control: credentials may use ordinary text fields or
    // contenteditable without a recognizable name/type. Never inspect values.
    mask: [page.locator('input,textarea,select,[contenteditable],iframe')],
    maskColor: '#111111',
  })
  if (image.length > 2 * 1024 * 1024)
    throw new Error('browser_interaction_denied')
  return BrowserCapturedImageSchema.parse({
    mimeType: 'image/jpeg',
    base64: image.toString('base64'),
  })
}
