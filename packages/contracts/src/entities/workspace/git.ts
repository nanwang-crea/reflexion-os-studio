import { z } from 'zod'

/** Git 变更类别：porcelain XY 聚合后的语义（Rust git.status 透传）。 */
export const GitChangeStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
])
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>

/** Git 变更条目：path 为工作区相对路径；oldPath 仅 renamed 时存在（原路径）。 */
export const GitChangeEntrySchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().optional(),
  status: GitChangeStatusSchema,
  staged: z.boolean(),
})
export type GitChangeEntry = z.infer<typeof GitChangeEntrySchema>
