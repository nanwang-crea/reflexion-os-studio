import { z } from 'zod'
import {
  AgentBrowserPageSchema,
  AgentBrowserUrlSchema,
  AgentBrowserDocumentSchema,
} from '../agent.js'
export const BrowserCapturedImageSchema = z.strictObject({
  mimeType: z.literal('image/jpeg'),
  base64: z
    .string()
    .max(2800000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
})
export const BrowserExecutionResultSchema = z.strictObject({
  document: AgentBrowserDocumentSchema.nullable(),
  completed: z.number().int().min(0).max(20),
  failedStep: z.number().int().min(0).max(19).nullable(),
  failurePhase: z.enum(['before-action', 'action', 'after-action']).optional(),
  error: z
    .enum([
      'browser_interaction_denied',
      'browser_interaction_network_denied',
      'browser_interaction_failed',
      'browser_page_stale',
      // Legacy result compatibility; current workers do not emit this code.
      'browser_sensitive_content',
      'browser_plan_timeout',
      'browser_operation_failed',
      'browser_navigation_timeout',
      'browser_navigation_blocked',
      'browser_navigation_failed',
      'browser_network_dns_failed',
      'browser_network_connection_refused',
      'browser_network_certificate',
      'browser_page_loading',
      'browser_page_unavailable',
      'browser_target_missing',
      'browser_target_ambiguous',
      'browser_closed',
    ])
    .nullable(),
  screenshots: z
    .array(
      z.strictObject({
        step: z.number().int().min(0).max(19),
        image: BrowserCapturedImageSchema,
        page: AgentBrowserPageSchema,
        sourceUrl: AgentBrowserUrlSchema,
      }),
    )
    .max(4),
})
export type BrowserExecutionResult = z.infer<
  typeof BrowserExecutionResultSchema
>
