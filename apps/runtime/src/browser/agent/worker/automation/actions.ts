import type { Page } from 'playwright'
import type { BrowserStep } from '@reflexion-os-studio/contracts'
import { automationTarget } from './targets.js'
import { captureBrowserImage } from './screenshot.js'

export async function runBrowserStep(
  page: Page,
  snapshot: string,
  step: BrowserStep,
  navigate: (url: string) => Promise<unknown>,
  timeout: number,
) {
  if (step.action === 'goto') {
    await navigate(step.url)
    return null
  }
  if (step.action === 'wait') {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step.milliseconds, timeout)),
    )
    return null
  }
  if (step.action === 'read') return null
  if (step.action === 'screenshot')
    return captureBrowserImage(page, step.fullPage)
  if (step.action === 'scroll') {
    const amount = { left: step.deltaX, top: step.deltaY }
    if (step.target) {
      const target = await automationTarget(page, snapshot, step.target)
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
  const typing = step.action === 'type'
  const submit =
    (step.action === 'type' && step.submit) ||
    (step.action === 'press' && step.key === 'Enter')
  const target = await automationTarget(
    page,
    snapshot,
    step.target,
    typing,
    submit,
  )
  switch (step.action) {
    case 'click':
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
      const source = await automationTarget(page, snapshot, step.source)
      await source.dragTo(target, { timeout })
      break
    }
  }
  return null
}
