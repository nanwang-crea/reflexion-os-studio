import type { Page } from 'playwright'
import {
  BrowserExecutionResultSchema,
  type AgentBrowserDocument,
  type BrowserExecutionResult,
  type BrowserPlan,
} from '@reflexion-os-studio/contracts'
import { runBrowserStep } from './actions.js'
import { browserFailure } from '../errors.js'

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
  let failedStep = 0
  let failurePhase: 'before-action' | 'action' | 'after-action' =
    'before-action'
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
  const referenceUrl = context.page()?.url()
  const execute = async () => {
    for (const [index, step] of plan.steps.entries()) {
      failedStep = index
      failurePhase = 'before-action'
      check()
      const page = context.page()
      if (!page) throw new Error('browser_closed')
      // Waiting and navigation must work even while the old page is loading.
      if (step.action !== 'wait' && step.action !== 'goto') {
        document = await context.capture()
        check()
        const usesRef =
          ('target' in step && step.target && 'ref' in step.target) ||
          ('source' in step && 'ref' in step.source)
        if (usesRef && document.sourceUrl !== referenceUrl)
          throw new Error('browser_page_stale')
      }
      const sourceUrl = page.url()
      failurePhase = 'action'
      const image = await runBrowserStep(
        page,
        step,
        context.navigate,
        Math.min(5000, deadline - Date.now()),
      )
      completed++
      failurePhase = 'after-action'
      check()
      const after = await context.capture()
      check()
      if (image && after.sourceUrl !== sourceUrl)
        throw new Error('browser_page_loading')
      document = after
      if (image)
        screenshots.push({
          step: index,
          image,
          page: after.page,
          sourceUrl: after.sourceUrl,
        })
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
          ? browserFailure(error).message
          : 'browser_interaction_failed'
    const parsed = BrowserExecutionResultSchema.shape.error.safeParse(
      code === 'browser_operation_failed' ? 'browser_interaction_failed' : code,
    )
    const safe = parsed.success ? parsed.data : 'browser_interaction_failed'
    context.invalidate()
    if (safe === 'browser_plan_timeout') {
      expired = true
      await close()
    }
    return {
      document: null,
      completed,
      failedStep,
      failurePhase,
      error: safe,
      screenshots: [...screenshots],
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
