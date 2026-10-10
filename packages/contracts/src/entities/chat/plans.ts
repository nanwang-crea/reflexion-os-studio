import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'

export const PlanStatusSchema = z.enum(['active', 'completed', 'cancelled'])
export type PlanStatus = z.infer<typeof PlanStatusSchema>

export const PlanStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'cancelled',
])
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  title: z.string().min(1),
  status: PlanStepStatusSchema,
  note: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type PlanStep = z.infer<typeof PlanStepSchema>

export const PlanSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1).nullable(),
  goal: z.string().min(1),
  status: PlanStatusSchema,
  summary: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  steps: z.array(PlanStepSchema),
})
export type Plan = z.infer<typeof PlanSchema>
