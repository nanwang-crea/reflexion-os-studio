import type { Page } from 'playwright'
import type { BrowserTarget } from '@reflexion-os-studio/contracts'
import {
  assertSnapshotTarget,
  checkInteractionTarget,
} from '../../security/interaction.js'

export async function automationTarget(
  page: Page,
  snapshot: string,
  target: BrowserTarget,
  typing = false,
  submit = false,
) {
  let ref: string
  if ('ref' in target) ref = target.ref
  else {
    const lines = snapshot.split('\n').filter((line) => {
      const clean = line.trim().replace(/^-\s*/, '')
      return (
        clean.startsWith(`${target.role} ${JSON.stringify(target.name)} `) ||
        clean.startsWith(`${target.role} ${JSON.stringify(target.name)}:`)
      )
    })
    if (lines.length !== 1) throw new Error('browser_page_stale')
    const match = /\[ref=((?:f\d+)?e\d+)\]/.exec(lines[0])
    if (!match) throw new Error('browser_page_stale')
    ref = match[1]
  }
  assertSnapshotTarget(snapshot, ref, target.name)
  await checkInteractionTarget(page, ref, typing, submit)
  return page.locator(`aria-ref=${ref}`)
}
