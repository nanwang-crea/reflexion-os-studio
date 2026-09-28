import { z } from 'zod'
import { SkillManifestSchema } from '../entities.js'
import { RequestIdSchema } from './params.js'

export const skillCommands = {
  'skill.list': {
    // 内置 Skill 清单（Phase 1A 无安装/启停，列表即全部可用项）。
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ skills: z.array(SkillManifestSchema) }),
  },
}
