import { z } from 'zod'
import {
  AgentTemplateSchema,
  AgentModelBindingSchema,
  PermissionPresetSchema,
} from '../entities.js'
import { RequestIdSchema } from './params.js'

export const agentTemplateCommands = {
  'agent_template.list': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ templates: z.array(AgentTemplateSchema) }),
  },
  'agent_template.save': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1).optional(),
      name: z.string().min(1).max(80),
      description: z.string().max(500),
      systemPrompt: z.string().min(1).max(20_000),
      projectId: z.string().min(1).nullable().optional(),
      domains: z.array(z.string().min(1).max(40)).max(12).optional(),
      modelBinding: AgentModelBindingSchema.optional(),
      permissionCeiling: PermissionPresetSchema.optional(),
      enabled: z.boolean(),
      canDelegate: z.boolean(),
      allowedTools: z.array(z.string().min(1)),
    }),
    result: z.object({ template: AgentTemplateSchema }),
  },
  'agent_template.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      templateId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
}

export type AgentTemplateSaveParams = z.input<
  (typeof agentTemplateCommands)['agent_template.save']['params']
>
