import { z } from 'zod'
import {
  AgentModelBindingSchema,
  AgentSkillBindingsSchema,
  PermissionPresetSchema,
} from '../entities.js'
import { RequestIdSchema } from './params.js'

export const AgentTemplateSaveParamsSchema = z.object({
  requestId: RequestIdSchema,
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  systemPrompt: z.string().min(1).max(20_000),
  projectId: z.string().min(1).nullable().optional(),
  domains: z.array(z.string().min(1).max(40)).max(12).optional(),
  modelBinding: AgentModelBindingSchema.optional(),
  skills: AgentSkillBindingsSchema.optional(),
  permissionCeiling: PermissionPresetSchema.optional(),
  enabled: z.boolean(),
  canDelegate: z.boolean(),
  allowedTools: z.array(z.string().min(1)),
})
