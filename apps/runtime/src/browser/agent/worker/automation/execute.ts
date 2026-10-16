import type { Page } from 'playwright'
import {
  BrowserExecutionResultSchema,
  type AgentBrowserDocument,
  type BrowserExecutionResult,
  type BrowserPlan,
} from '@reflexion-os-studio/contracts'
import { runBrowserStep } from './actions.js'

export interface AutomationContext {
  page: () => Page | undefined
  capture: () => Promise<AgentBrowserDocument>
  navigate: (url: string) => Promise<unknown>
  blocked: () => boolean
  current: () => boolean
  invalidate: () => void
  close: () => Promise<void>
}

/** A timed-out plan cannot continue issuing browser actions in the background. */
export async function executeBrowserPlan(
  plan: BrowserPlan,
  context: AutomationContext,
): Promise<BrowserExecutionResult> {
  let completed = 0
  let document: AgentBrowserDocument | null = null
  const screenshots: BrowserExecutionResult['screenshots'] = []
  let closing: Promise<void> | undefined
  const close = () => (closing ??= context.close())
  let expired = false
  const deadline = Date.now() + plan.timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (expired || Date.now() >= deadline)
      throw new Error('browser_plan_timeout')
    if (!context.current()) throw new Error('browser_page_stale')
    if (context.blocked()) throw new Error('browser_interaction_network_denied')
  }
  const execute = async () => {
    for (const step of plan.steps) {
      check()
      document = await context.capture()
      check()
      const page = context.page()
      if (!page || !document.snapshot) throw new Error('browser_page_stale')
      const image = await runBrowserStep(
        page,
        document.snapshot,
        step,
        context.navigate,
        Math.min(5000, deadline - Date.now()),
      )
      check()
      const after = await context.capture()
      check()
      if (
        image &&
        (after.sourceUrl !== document.sourceUrl ||
          after.snapshot !== document.snapshot)
      )
        throw new Error('browser_page_stale')
      document = after
      if (image)
        screenshots.push({
          step: completed,
          image,
          page: after.page,
          sourceUrl: after.sourceUrl,
        })
      completed++
    }
  }
  try {
    await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          void close().catch(() => {})
          reject(new Error('browser_plan_timeout'))
        }, plan.timeoutMs)
      }),
    ])
    return { document, completed, failedStep: null, error: null, screenshots }
  } catch (error) {
    const code = expired
      ? 'browser_plan_timeout'
      : context.blocked()
        ? 'browser_interaction_network_denied'
        : error instanceof Error
          ? error.message
          : ''
    const parsed = BrowserExecutionResultSchema.shape.error.safeParse(
      code === 'browser_operation_failed' ? 'browser_interaction_failed' : code,
    )
    const safe = parsed.success ? parsed.data : 'browser_interaction_failed'
    context.invalidate()
    if (safe === 'browser_plan_timeout') {
      expired = true
      await close()
    }
    if (safe === 'browser_sensitive_content') {
      await close()
      screenshots.length = 0
    }
    return {
      document: null,
      completed,
      failedStep: Math.min(completed, 19),
      error: safe,
      screenshots: [...screenshots],
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
