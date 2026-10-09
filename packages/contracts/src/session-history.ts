import { z } from 'zod'
import {
  MessageSchema,
  RunSchema,
  SessionSchema,
  ToolCallSchema,
  PlanSchema,
  RunEventSchema,
} from './entities.js'

export const HistoryCursorSchema = z.object({
  createdAt: z.string().min(1),
  rowId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>

export const SessionHistorySchema = z.object({
  session: SessionSchema.nullable(),
  messages: z.array(MessageSchema),
  runs: z.array(RunSchema),
  toolCalls: z.array(ToolCallSchema),
  plans: z.array(PlanSchema),
  runEvents: z.array(RunEventSchema).default([]),
  positions: z.record(z.string(), HistoryCursorSchema),
  nextBefore: HistoryCursorSchema.nullable(),
})
export type SessionHistory = z.infer<typeof SessionHistorySchema>
