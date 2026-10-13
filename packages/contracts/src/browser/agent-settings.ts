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

export const AgentBrowserRuntimeSchema = z.strictObject({
  state: z.enum(['not-installed', 'downloading', 'installed', 'failed']),
  progress: z.number().min(0).max(100).nullable(),
  phase: z.enum(['idle', 'download', 'verify', 'ready', 'failed']),
  version: z.string().min(1),
  error: z
    .enum(['download-failed', 'download-cancelled', 'runtime-unavailable'])
    .nullable(),
})
export type AgentBrowserRuntime = z.infer<typeof AgentBrowserRuntimeSchema>

/** Local installation marker written only after executable validation. */
export const AgentBrowserInstallationSchema = z.strictObject({
  version: z.string().min(1),
  executable: z.string().min(1),
})
