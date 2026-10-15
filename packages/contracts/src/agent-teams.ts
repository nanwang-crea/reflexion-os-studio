import { z } from 'zod'
import { agentTemplateCommands } from './commands/agent-template.js'

export const AgentTeamInspectInputSchema = z
  .object({
    teamId: z.string().min(1).max(32).optional(),
    templateId: z.string().min(1).optional(),
  })
  .strict()

export const AgentTeamRoleInputSchema = agentTemplateCommands[
  'agent_template.save'
].params
  .omit({ requestId: true, id: true, projectId: true })
  .extend({
    name: z.string().trim().min(1).max(80),
    domains: z.array(z.string().min(1).max(40)).max(11).default([]),
  })
  .strict()

export const AgentTeamCreateInputSchema = z
  .object({
    teamId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    scope: z.enum(['project', 'global']),
    roles: z.array(AgentTeamRoleInputSchema).min(1).max(8),
  })
  .strict()

const AgentTeamTargetSchema = AgentTeamCreateInputSchema.pick({
  teamId: true,
  scope: true,
}).extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
})

export const AgentTeamUpdateInputSchema = AgentTeamTargetSchema.extend({
  roles: z
    .array(
      AgentTeamRoleInputSchema.extend({
        id: z.string().min(1).optional(),
      }).strict(),
    )
    .max(8)
    .default([]),
  removeRoleIds: z.array(z.string().min(1)).max(8).default([]),
}).strict()

export const AgentTeamDeleteInputSchema = AgentTeamTargetSchema.strict()

export type AgentTeamCreateInput = z.infer<typeof AgentTeamCreateInputSchema>

export const agentTeamToolParameters = {
  inspect: z.toJSONSchema(AgentTeamInspectInputSchema, { io: 'input' }),
  update: z.toJSONSchema(AgentTeamUpdateInputSchema, { io: 'input' }),
  delete: z.toJSONSchema(AgentTeamDeleteInputSchema, { io: 'input' }),
  create: z.toJSONSchema(AgentTeamCreateInputSchema, { io: 'input' }),
}
