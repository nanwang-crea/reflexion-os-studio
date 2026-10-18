import type { Page } from 'playwright'
import type { BrowserStep } from '@reflexion-os-studio/contracts'
import { automationTarget } from './targets.js'
import { captureBrowserImage } from './screenshot.js'

export async function runBrowserStep(
  page: Page,
  step: BrowserStep,
  navigate: (url: string) => Promise<unknown>,
  timeout: number,
) {
  if (step.action === 'goto') {
    await navigate(step.url)
    return null
  }
  if (step.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, step.milliseconds))
    return null
  }
  if (step.action === 'read') return null
  if (step.action === 'screenshot')
    return captureBrowserImage(page, step.fullPage)
  if (step.action === 'scroll') {
    const amount = { left: step.deltaX, top: step.deltaY }
    if (step.target) {
      const target = await automationTarget(page, step.target)
      await target.evaluate(
        (element, amount) =>
          element.scrollBy({ ...amount, behavior: 'instant' }),
        amount,
        { timeout },
      )
    } else
      await page.evaluate(
        (amount) => window.scrollBy({ ...amount, behavior: 'instant' }),
        amount,
      )
    return null
  }
  const target = await automationTarget(page, step.target)
  switch (step.action) {
    case 'click':
      // Keep links in the visible session-owned tab instead of losing popup ownership.
      await target.evaluate(
        (element) => {
          const link = element.closest('a')
          if (link?.hasAttribute('target')) link.setAttribute('target', '_self')
          const form = element.closest('form')
          if (form?.hasAttribute('target')) form.setAttribute('target', '_self')
        },
        undefined,
        { timeout },
      )
      await target.click({
        button: step.button,
        clickCount: step.count,
        timeout,
      })
      break
    case 'type':
      await target.fill(step.text, { timeout })
      if (step.submit) await target.press('Enter', { timeout })
      break
    case 'reveal':
      await target.scrollIntoViewIfNeeded({ timeout })
      break
    case 'hover':
      await target.hover({ timeout })
      break
    case 'press':
      await target.press(step.key, { timeout })
      break
    case 'select':
      await target.selectOption(step.values, { timeout })
      break
    case 'drag': {
      const source = await automationTarget(page, step.source)
      await source.dragTo(target, { timeout })
      break
    }
  }
  return null
}
