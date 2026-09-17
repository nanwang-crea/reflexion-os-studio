import { z } from 'zod'

// ── Request ──

export const AnthropicContentBlockParamSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    source: z.object({
      type: z.enum(['base64', 'url']),
      media_type: z.string(),
      data: z.string().optional(),
      url: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional(),
  }),
])
export type AnthropicContentBlockParam = z.infer<
  typeof AnthropicContentBlockParamSchema
>

export const AnthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(AnthropicContentBlockParamSchema)]),
})
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>

export const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
})
export type AnthropicTool = z.infer<typeof AnthropicToolSchema>

export const AnthropicToolChoiceSchema = z.union([
  z.object({ type: z.literal('auto') }),
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('tool'), name: z.string() }),
  z.object({ type: z.literal('none') }),
])
export type AnthropicToolChoice = z.infer<typeof AnthropicToolChoiceSchema>

export const AnthropicThinkingSchema = z.union([
  z.object({ type: z.literal('disabled') }),
  z.object({
    type: z.literal('enabled'),
    budget_tokens: z.number().int().positive(),
  }),
])
export type AnthropicThinking = z.infer<typeof AnthropicThinkingSchema>

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessageSchema),
  max_tokens: z.number().int().positive(),
  system: z
    .union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))])
    .optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  tools: z.array(AnthropicToolSchema).optional(),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  thinking: AnthropicThinkingSchema.optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z
    .object({ user_id: z.string().optional() })
    .optional(),
})
export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>

// ── Response (non-streaming) ──

export const AnthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
  }),
])
export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>

export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
})
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>

export const AnthropicStopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
])
export type AnthropicStopReason = z.infer<typeof AnthropicStopReasonSchema>

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(AnthropicContentBlockSchema),
  model: z.string(),
  stop_reason: AnthropicStopReasonSchema.nullable(),
  stop_sequence: z.string().nullable(),
  usage: AnthropicUsageSchema,
})
export type AnthropicMessagesResponse = z.infer<
  typeof AnthropicMessagesResponseSchema
>

// ── Streaming events ──

export const AnthropicStreamEventSchema = z.union([
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      id: z.string(),
      type: z.literal('message'),
      role: z.literal('assistant'),
      model: z.string(),
      stop_reason: z.null(),
      usage: AnthropicUsageSchema,
    }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.union([
      z.object({ type: z.literal('text'), text: z.literal('') }),
      z.object({ type: z.literal('thinking'), thinking: z.literal('') }),
      z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.union([
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({
        type: z.literal('input_json_delta'),
        partial_json: z.string(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.number(),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({
      stop_reason: AnthropicStopReasonSchema.nullable(),
      stop_sequence: z.string().nullable(),
      output_tokens: z.number().int().nonnegative().optional(),
    }),
    usage: z.object({ output_tokens: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal('message_stop'),
  }),
  z.object({
    type: z.literal('ping'),
  }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      type: z.string(),
      message: z.string(),
    }),
  }),
])
export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEventSchema>
