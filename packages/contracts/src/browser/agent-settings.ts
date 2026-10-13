import { z } from 'zod'

export const AgentBrowserDisplaySchema = z.enum(['headless', 'headed'])
export type AgentBrowserDisplay = z.infer<typeof AgentBrowserDisplaySchema>
export const AgentBrowserApprovalSchema = z.enum([
  'follow-session',
  'ask',
  'allow-read-only',
])
export type AgentBrowserApproval = z.infer<typeof AgentBrowserApprovalSchema>
export const AgentBrowserSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  display: AgentBrowserDisplaySchema.default('headless'),
  approval: AgentBrowserApprovalSchema.default('follow-session'),
})
export type AgentBrowserSettings = z.infer<typeof AgentBrowserSettingsSchema>
export const DEFAULT_AGENT_BROWSER_SETTINGS = AgentBrowserSettingsSchema.parse(
  {},
)
