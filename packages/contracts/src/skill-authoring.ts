import { z } from 'zod'
import { SkillSaveParamsSchema } from './commands/skill.js'

export const SkillPrepareInputSchema = z
  .object({
    skillId: z.string().min(1),
    resource: z.string().min(1).optional(),
  })
  .strict()
export const SkillAuthorInputSchema = SkillSaveParamsSchema.omit({
  requestId: true,
  projectId: true,
})
  .extend({ scope: z.enum(['project', 'global']) })
  .strict()
export const skillAuthoringParameters = {
  save: z.toJSONSchema(SkillAuthorInputSchema, { io: 'input' }),
  prepare: z.toJSONSchema(SkillPrepareInputSchema, { io: 'input' }),
}

export const SkillPreparedSchema = z.object({
  skillId: z.string(),
  version: z.string(),
  directory: z.string(),
  nodeExecutable: z.string(),
  resources: z.array(z.string()),
  resource: z.object({ path: z.string(), content: z.string() }).nullable(),
})
export type SkillPrepared = z.infer<typeof SkillPreparedSchema>
