import type { Page } from 'playwright'
import type { BrowserTarget } from '@reflexion-os-studio/contracts'

export async function automationTarget(page: Page, target: BrowserTarget) {
  const locator =
    'ref' in target
      ? page.locator(`aria-ref=${target.ref}`)
      : page.getByRole(target.role, { name: target.name, exact: true })
  await locator.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {
    throw new Error('browser_target_missing')
  })
  if ((await locator.count()) !== 1) throw new Error('browser_target_ambiguous')
  return locator
}
