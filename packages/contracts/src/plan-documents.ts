import { z } from 'zod'

export const PlanSnapshotSchema = z.object({
  planId: z.string().uuid(),
  goal: z.string().min(1),
  markdown: z
    .string()
    .min(1)
    .max(100_000)
    .refine((text) => text.trim().length > 0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().nullable(),
  projectId: z.string().nullable(),
  specification: z.string(),
})
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>

export const PlanDocumentSchema = z.object({
  snapshot: PlanSnapshotSchema,
  retained: z.boolean(),
  state: z.enum(['active', 'cleanup_pending', 'deleted', 'preserved']),
})
export type PlanDocument = z.infer<typeof PlanDocumentSchema>

export const PlanDocumentReadResultSchema = z.object({
  content: z.string().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
})
export const PlanDocumentWriteResultSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const PlanDocumentCleanupResultSchema = z.object({
  state: z.enum(['deleted', 'preserved']),
})
