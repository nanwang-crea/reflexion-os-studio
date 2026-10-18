import {
  BrowserExecutionResultSchema,
  BrowserPlanSchema,
  type AgentBrowserPage,
} from '@reflexion-os-studio/contracts'

export function validateExecutionResult(
  args: unknown,
  current: AgentBrowserPage | null,
  raw: string,
) {
  const plan = BrowserPlanSchema.parse(args)
  const result = BrowserExecutionResultSchema.parse(JSON.parse(raw))
  const invalid = () => {
    throw new Error('browser_response_invalid')
  }
  if (
    !current ||
    result.completed > plan.steps.length ||
    (result.error === null &&
      (result.completed !== plan.steps.length || !result.document?.snapshot)) ||
    (result.error !== null &&
      (result.failedStep !==
        result.completed - (result.failurePhase === 'after-action' ? 1 : 0) ||
        result.document !== null))
  )
    invalid()
  if (
    result.document &&
    (result.document.page.tabId !== current!.tabId ||
      new URL(result.document.sourceUrl).origin !== result.document.page.origin)
  )
    invalid()
  const seen = new Set<number>()
  for (const screenshot of result.screenshots) {
    if (
      screenshot.page.tabId !== current!.tabId ||
      new URL(screenshot.sourceUrl).origin !== screenshot.page.origin ||
      screenshot.step >= result.completed ||
      plan.steps[screenshot.step]?.action !== 'screenshot' ||
      seen.has(screenshot.step)
    )
      invalid()
    seen.add(screenshot.step)
  }
  return result
}
