import { z } from 'zod'
import { SkillSaveParamsSchema } from './commands/skill.js'

export const MAX_SKILL_RESOURCE_PAGE_BYTES = 100000

export const SkillResourceReadOptionsSchema = z
  .object({
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'UTF-8 字节偏移，默认 0；续读使用上一页返回的 nextOffset，不要按字符数计算。',
      ),
    limit: z
      .number()
      .int()
      .min(4)
      .max(MAX_SKILL_RESOURCE_PAGE_BYTES)
      .optional()
      .describe(
        '每页最多读取的字节数，默认 100000；至少 4 字节以容纳完整 UTF-8 字符。',
      ),
  })
  .strict()
export type SkillResourceReadOptions = z.infer<
  typeof SkillResourceReadOptionsSchema
>

export const SkillPrepareInputSchema = SkillResourceReadOptionsSchema.extend({
  skillId: z.string().min(1),
  resource: z.string().min(1).optional(),
})
  .strict()
  .refine(
    (input) =>
      input.resource !== undefined ||
      (input.offset === undefined && input.limit === undefined),
    {
      message: 'offset / limit 仅能在指定 resource 时使用',
      path: ['resource'],
    },
  )
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

export const SkillResourcePageSchema = z.object({
  path: z.string(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative().max(MAX_SKILL_RESOURCE_PAGE_BYTES),
  totalBytes: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
})
export type SkillResourcePage = z.infer<typeof SkillResourcePageSchema>

export const SkillPreparedSchema = z.object({
  skillId: z.string(),
  version: z.string(),
  directory: z.string(),
  nodeExecutable: z.string(),
  resources: z.array(z.string()),
  resource: SkillResourcePageSchema.nullable(),
})
export type SkillPrepared = z.infer<typeof SkillPreparedSchema>
