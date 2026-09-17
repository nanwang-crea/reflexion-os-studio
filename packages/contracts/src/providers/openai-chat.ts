import { z } from 'zod'

// ── Request ──

export const OpenAIChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})
export type OpenAIChatMessage = z.infer<typeof OpenAIChatMessageSchema>

export const OpenAIChatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type OpenAIChatTool = z.infer<typeof OpenAIChatToolSchema>

export const OpenAIChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenAIChatMessageSchema),
  stream: z.boolean().optional(),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(OpenAIChatToolSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
})
export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>

// ── Response (non-streaming) ──

export const OpenAIChatUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
  prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
})
export type OpenAIChatUsage = z.infer<typeof OpenAIChatUsageSchema>

export const OpenAIChatChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal('function'),
          function: z.object({
            name: z.string(),
            arguments: z.string(),
          }),
        }),
      )
      .optional(),
  }),
  finish_reason: z.string().nullable(),
})
export type OpenAIChatChoice = z.infer<typeof OpenAIChatChoiceSchema>

export const OpenAIChatResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number(),
  model: z.string(),
  choices: z.array(OpenAIChatChoiceSchema),
  usage: OpenAIChatUsageSchema.optional(),
})
export type OpenAIChatResponse = z.infer<typeof OpenAIChatResponseSchema>

// ── Streaming delta ──

export const OpenAIChatStreamDeltaSchema = z.object({
  id: z.string().optional(),
  object: z.literal('chat.completion.chunk').optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        delta: z.object({
          role: z.literal('assistant').optional(),
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          reasoning: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                id: z.string().optional(),
                function: z
                  .object({
                    name: z.string().optional(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .optional(),
  usage: OpenAIChatUsageSchema.optional(),
})
export type OpenAIChatStreamDelta = z.infer<typeof OpenAIChatStreamDeltaSchema>
