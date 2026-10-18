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
