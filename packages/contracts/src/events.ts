import { z } from 'zod'
import { MessageSchema, RunSchema, SessionSchema } from './entities.js'
import { RuntimeErrorSchema } from './errors.js'
import { RuntimeStatusSchema } from './handshake.js'

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'content_filter',
  'cancelled',
])
export type FinishReason = z.infer<typeof FinishReasonSchema>

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
})
export type Usage = z.infer<typeof UsageSchema>

export const RuntimeEventEnvelopeSchema = z.object({
  protocolVersion: z.string(),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
})
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('runtime.status'),
    status: RuntimeStatusSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('session.created'),
    session: SessionSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.created'),
    message: MessageSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.reasoning_delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.completed'),
    messageId: z.string().min(1),
    content: z.string(),
    finishReason: FinishReasonSchema,
    usage: UsageSchema.optional(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.started'),
    run: RunSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.completed'),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.failed'),
    error: RuntimeErrorSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.cancelled'),
  }),
])
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>

export type RuntimeEventName = RuntimeEvent['type']
