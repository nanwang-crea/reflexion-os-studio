import { z } from 'zod'
import { PluginRecordSchema, SkillManifestSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const SkillSaveParamsSchema = z.object({
  requestId: RequestIdSchema,
  id: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
  instructions: z.string().min(1).max(20000),
  projectId: z.string().min(1).nullable(),
})
export type SkillSaveParams = z.infer<typeof SkillSaveParamsSchema>

export const skillCommands = {
  'skill.save': {
    params: SkillSaveParamsSchema,
    result: z.object({ plugin: PluginRecordSchema }),
  },
  'skill.list': {
    // 内置 Skill 清单（Phase 1A 无安装/启停，列表即全部可用项）。
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ skills: z.array(SkillManifestSchema) }),
  },
}
