import { z } from 'zod'
import { JsonValueSchema } from './json-value.js'

const count = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
  .describe('原始快照中必须精确出现的次数，默认 1；必须是正整数')
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const FileEditOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('replace'),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedCount: count,
  }),
  z.strictObject({
    kind: z.literal('insert_before'),
    anchor: z.string().min(1),
    content: z.string(),
    expectedCount: count,
  }),
  z.strictObject({
    kind: z.literal('insert_after'),
    anchor: z.string().min(1),
    content: z.string(),
    expectedCount: count,
  }),
  z
    .strictObject({
      kind: z.literal('replace_range'),
      startLine: line.describe(
        '1 起始绝对行号，包含首行；直接使用 file.read 的 L 行号',
      ),
      endLine: line.describe('1 起始绝对行号，包含末行，必须 >= startLine'),
      expectedText: z
        .string()
        .describe(
          '范围内完整原文，保留行间换行，不含末行后的换行；可复制对应的 L 行号前缀',
        ),
      newText: z.string(),
    })
    .refine((value) => value.endLine >= value.startLine, {
      message: 'endLine must be >= startLine',
      path: ['endLine'],
    }),
])
export const FileEditInputSchema = z.union([
  z.strictObject({
    path: z.string().min(1),
    edits: z
      .array(FileEditOperationSchema)
      .min(1)
      .describe(
        '同一原始快照上的原子操作；不与 oldText/newText/expectedCount 混用',
      ),
  }),
  z.strictObject({
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedCount: count,
  }),
])
export const FileEditDiagnosticSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  kind: z.enum(['replace', 'insert_before', 'insert_after', 'replace_range']),
  reason: z.enum([
    'invalid_range',
    'text_mismatch',
    'invalid_match',
    'invalid_count',
    'match_count',
    'overlap',
  ]),
  candidateLines: z.array(z.number().int().positive()).max(20).optional(),
  actualCount: z.number().int().nonnegative().optional(),
  expectedCount: z.number().int().positive().optional(),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  conflictingOperationIndex: z.number().int().nonnegative().optional(),
  noChangesWritten: z.literal(true),
})
export type FileEditOperation = z.infer<typeof FileEditOperationSchema>
export type FileEditDiagnostic = z.infer<typeof FileEditDiagnosticSchema>
export const FileEditParameters = JsonValueSchema.parse({
  ...z.toJSONSchema(FileEditInputSchema),
  type: 'object',
})
