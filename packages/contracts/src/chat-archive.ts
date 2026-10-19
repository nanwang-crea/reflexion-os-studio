import { DocumentUploadSchema } from './attachments.js'
import { z } from 'zod'
import { JsonValueSchema } from './json-value.js'
import { IsoDateTimeSchema } from './entities/shared.js'
import { ImageUploadSchema } from './images.js'

export const MAX_CHAT_ARCHIVE_BYTES = 16 * 1024 * 1024
const id = z.string().min(1).max(200)
const ArchiveToolSchema = z.strictObject({
  name: z.string().min(1).max(300),
  args: JsonValueSchema,
  content: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  errorCode: z.string().nullable(),
})
export const ChatArchiveSchema = z.strictObject({
  format: z.literal('reflexion-chat'),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: IsoDateTimeSchema,
  title: z.string().min(1).max(1000),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        reasoning: z.string(),
        createdAt: IsoDateTimeSchema,
        status: z.enum(['completed', 'failed', 'interrupted']),
        model: z.string().nullable(),
        runKey: id.nullable().default(null),
        images: z.array(id).max(4),
        files: z.array(id).max(4).default([]),
        tools: z.array(ArchiveToolSchema).max(1000),
      }),
    )
    .max(100_000),
  files: z
    .array(DocumentUploadSchema.omit({ sessionId: true }).extend({ id }))
    .max(1000)
    .default([]),
  images: z
    .array(ImageUploadSchema.omit({ sessionId: true }).extend({ id }))
    .max(1000),
})
export type ChatArchive = z.infer<typeof ChatArchiveSchema>

/** UI-selected paths only; no agent tool exposes this sidecar capability. */
export const ChatArchiveFileRequestSchema = z.strictObject({
  action: z.enum(['read', 'write', 'directory']),
  workspaceRoot: z.string().min(1),
  path: z.string().optional(),
  content: z.string().max(MAX_CHAT_ARCHIVE_BYTES).optional(),
})
export const ChatArchiveFileResultSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
})

export type ChatArchiveFileRequest = z.infer<
  typeof ChatArchiveFileRequestSchema
>
