import { z } from 'zod'
import { AgentTemplateSaveParamsSchema } from './commands/agent-template-input.js'

export const MAX_AGENT_ROLE_SHARE_BYTES = 256 * 1024

/** Portable role guidance; machine-local identity and model bindings are omitted. */
export const SharedAgentRoleSchema = AgentTemplateSaveParamsSchema.pick({
  name: true,
  description: true,
  systemPrompt: true,
  domains: true,
  permissionCeiling: true,
  canDelegate: true,
  allowedTools: true,
})
  .extend({
    permissionCeiling: AgentTemplateSaveParamsSchema.shape.permissionCeiling
      .unwrap()
      .default('workspace-read'),
  })
  .strict()

export const AgentRoleShareSchema = z.strictObject({
  format: z.literal('reflexion-role'),
  version: z.literal(1),
  role: SharedAgentRoleSchema,
})

export const MAX_AGENT_TEAM_SHARE_BYTES = 4 * 1024 * 1024
export const AgentTeamShareSchema = z.strictObject({
  format: z.literal('reflexion-team'),
  version: z.literal(1),
  teamId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(32),
  roles: z.array(SharedAgentRoleSchema).min(1).max(500),
})
export type AgentTeamShare = z.infer<typeof AgentTeamShareSchema>
