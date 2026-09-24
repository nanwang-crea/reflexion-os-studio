import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from './json-value.js'
import { ResourceLinkSchema } from './resource-links.js'

/** A workspace mutation's filesystem effect. Paths are workspace-relative. */
export const ChangedFileActionSchema = z.enum([
  'created',
  'modified',
  'deleted',
  'moved',
])
export type ChangedFileAction = z.infer<typeof ChangedFileActionSchema>

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  action: ChangedFileActionSchema,
  oldPath: z.string().min(1).optional(),
  /** Tool-local snapshot; absent when the runtime cannot safely capture text. */
  before: z.string().optional(),
  after: z.string().optional(),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

/** Canonical persisted/UI envelope for every terminal tool execution. */
export const ToolOutputSchema = z.object({
  type: z.literal('tool_output'),
  version: z.literal(1),
  content: z.string(),
  data: JsonValueSchema.nullable(),
  resourceLinks: z.array(ResourceLinkSchema),
  changedFiles: z.array(ChangedFileSchema),
})
export type ToolOutput = z.infer<typeof ToolOutputSchema>

/** Read a persisted result_json value, wrapping pre-envelope history on demand. */
export function coerceToolOutput(value: JsonValue): ToolOutput {
  const current = ToolOutputSchema.safeParse(value)
  if (current.success) return current.data
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : null
  const changedFiles = record
    ? z.array(ChangedFileSchema).safeParse(record.changedFiles)
    : null
  const resourceLinks = record
    ? z
        .array(ResourceLinkSchema)
        .safeParse(record.resourceLinks ?? record.links)
    : null
  return {
    type: 'tool_output',
    version: 1,
    content: typeof value === 'string' ? value : JSON.stringify(value),
    data: value,
    resourceLinks: resourceLinks?.success ? resourceLinks.data : [],
    changedFiles: changedFiles?.success ? changedFiles.data : [],
  }
}
