import { z } from 'zod'
import { JsonValueSchema } from './json-value.js'

const index = z.number().int().nonnegative().max(4095)
export const FileWriteStreamInputSchema = z.strictObject({
  action: z.enum(['begin', 'append', 'status', 'commit', 'abort']),
  path: z.string().min(1).describe('工作区相对文件路径'),
  chunkIndex: index.optional().describe('append 的文本块序号，从 0 连续递增'),
  title: z.string().max(120).optional().describe('可选进度标签，不会写入文件'),
  content: z
    .string()
    .optional()
    .describe('append 的原样 UTF-8 文本，包含所需分隔符'),
})
export const FileWriteCheckpointSchema = z.strictObject({
  version: z.literal(1),
  workspaceRoot: z.string(),
  path: z.string(),
  uploadId: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['active', 'committed', 'aborted']),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .max(512 * 1024 * 1024),
  chunks: z
    .array(
      z.strictObject({
        index,
        title: z.string().max(120),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .max(4096),
})
export const FileWriteBeginResultSchema = z.object({
  uploadId: z.string().regex(/^[a-f0-9]{64}$/),
  nextOffset: z.literal(0),
})
export const FileWriteAppendResultSchema = z.object({
  nextOffset: z.number().int().nonnegative(),
})
export type FileWriteCheckpoint = z.infer<typeof FileWriteCheckpointSchema>
export const fileWriteStreamParameters = JsonValueSchema.parse(
  z.toJSONSchema(FileWriteStreamInputSchema),
)
