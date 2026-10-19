import { JsonValueSchema } from './json-value.js'
import { z } from 'zod'
import { FileEditInputSchema } from './file-edits.js'
import { ToolOutputSchema } from './tool-output.js'

/** Each file is atomic; the batch deliberately does not promise a filesystem transaction. */
export const FileEditBatchInputSchema = z.strictObject({
  files: z.array(FileEditInputSchema).min(1).max(16),
})
export const FileEditBatchResultSchema = z.object({
  atomicAcrossFiles: z.literal(false),
  results: z.array(
    z.object({
      path: z.string(),
      toolCallId: z.string(),
      status: z.enum(['completed', 'failed', 'cancelled', 'not_executed']),
      output: ToolOutputSchema.nullable(),
    }),
  ),
})
export type FileEditBatchResult = z.infer<typeof FileEditBatchResultSchema>
export type FileEditBatchInput = z.infer<typeof FileEditBatchInputSchema>

export const FileEditBatchParameters = JsonValueSchema.parse(
  z.toJSONSchema(FileEditBatchInputSchema),
)
