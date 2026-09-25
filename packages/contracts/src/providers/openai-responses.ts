import { z } from 'zod'

// ── Request ──

export const OpenAIResponsesInputTextSchema = z.object({
  type: z.literal('input_text'),
  text: z.string(),
})
export type OpenAIResponsesInputText = z.infer<
  typeof OpenAIResponsesInputTextSchema
>

export const OpenAIResponsesInputImageSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().optional(),
  file_id: z.string().optional(),
  detail: z.enum(['auto', 'low', 'high']).optional(),
})
export type OpenAIResponsesInputImage = z.infer<
  typeof OpenAIResponsesInputImageSchema
>

export const OpenAIResponsesInputContentSchema = z.union([
  OpenAIResponsesInputTextSchema,
  OpenAIResponsesInputImageSchema,
])
export type OpenAIResponsesInputContent = z.infer<
  typeof OpenAIResponsesInputContentSchema
>

export const OpenAIResponsesInputMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(OpenAIResponsesInputContentSchema)]),
})
export type OpenAIResponsesInputMessage = z.infer<
  typeof OpenAIResponsesInputMessageSchema
>

export const OpenAIResponsesFunctionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
})
export type OpenAIResponsesFunctionTool = z.infer<
  typeof OpenAIResponsesFunctionToolSchema
>

export const OpenAIResponsesToolSchema = z.union([
  OpenAIResponsesFunctionToolSchema,
  z.object({
    type: z.literal('web_search'),
    search_context_size: z.string().optional(),
  }),
  z.object({
    type: z.literal('file_search'),
    vector_store_ids: z.array(z.string()),
  }),
  z.object({
    type: z.literal('computer_use_preview'),
    display_width: z.number(),
    display_height: z.number(),
    environment: z.string(),
  }),
  z.object({ type: z.literal('code_interpreter') }),
])
export type OpenAIResponsesTool = z.infer<typeof OpenAIResponsesToolSchema>

export const OpenAIResponsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(OpenAIResponsesInputMessageSchema)]),
  instructions: z.string().optional(),
  tools: z.array(OpenAIResponsesToolSchema).optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  previous_response_id: z.string().optional(),
  tool_choice: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional(),
  reasoning: z
    .object({
      effort: z.enum(['low', 'medium', 'high']).optional(),
      summary: z.enum(['auto', 'concise', 'detailed', 'none']).optional(),
    })
    .optional(),
  text: z
    .object({
      format: z.union([
        z.object({ type: z.literal('text') }),
        z.object({ type: z.literal('json_object') }),
        z.object({
          type: z.literal('json_schema'),
          name: z.string(),
          schema: z.record(z.string(), z.unknown()),
        }),
      ]),
    })
    .optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})
export type OpenAIResponsesRequest = z.infer<
  typeof OpenAIResponsesRequestSchema
>

// ── Response (non-streaming) ──

export const OpenAIResponsesUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
})
export type OpenAIResponsesUsage = z.infer<typeof OpenAIResponsesUsageSchema>

export const OpenAIResponsesOutputMessageSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
  content: z.array(
    z.union([
      z.object({
        type: z.literal('output_text'),
        text: z.string(),
        annotations: z.array(z.unknown()).optional(),
      }),
      z.object({
        type: z.literal('refusal'),
        refusal: z.string(),
      }),
    ]),
  ),
})
export type OpenAIResponsesOutputMessage = z.infer<
  typeof OpenAIResponsesOutputMessageSchema
>

export const OpenAIResponsesFunctionCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
})
export type OpenAIResponsesFunctionCall = z.infer<
  typeof OpenAIResponsesFunctionCallSchema
>

export const OpenAIResponsesOutputItemSchema = z.union([
  OpenAIResponsesOutputMessageSchema,
  OpenAIResponsesFunctionCallSchema,
  z.object({ type: z.string() }), // catch-all for other output types
])
export type OpenAIResponsesOutputItem = z.infer<
  typeof OpenAIResponsesOutputItemSchema
>

export const OpenAIResponsesResponseSchema = z.object({
  id: z.string(),
  object: z.literal('response'),
  created_at: z.number(),
  status: z.enum([
    'in_progress',
    'completed',
    'failed',
    'cancelled',
    'incomplete',
  ]),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .optional(),
  model: z.string(),
  output: z.array(OpenAIResponsesOutputItemSchema),
  usage: OpenAIResponsesUsageSchema,
  max_output_tokens: z.number().int().nullable().optional(),
  temperature: z.number().nullable().optional(),
})
export type OpenAIResponsesResponse = z.infer<
  typeof OpenAIResponsesResponseSchema
>

// ── Streaming events ──

export const OpenAIResponsesStreamEventSchema = z.union([
  z.object({
    type: z.literal('response.created'),
    item: OpenAIResponsesOutputItemSchema,
  }),
  z.object({
    type: z.literal('response.output_item.added'),
    item: OpenAIResponsesOutputItemSchema,
  }),
  z.object({
    type: z.literal('response.output_item.done'),
    item: OpenAIResponsesOutputItemSchema,
  }),
  z.object({
    type: z.literal('response.content_part.added'),
    part: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('response.content_part.done'),
    part: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('response.output_text.delta'),
    item_id: z.string(),
    output_index: z.number(),
    content_index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('response.output_text.done'),
    item_id: z.string(),
    output_index: z.number(),
    content_index: z.number(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('response.function_call_arguments.delta'),
    item_id: z.string(),
    call_id: z.string(),
    output_index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('response.function_call_arguments.done'),
    item_id: z.string(),
    call_id: z.string(),
    output_index: z.number(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal('response.completed'),
    item: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('response.incomplete'),
    item: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('response.reasoning_summary_text.delta'),
    item_id: z.string(),
    output_index: z.number(),
    content_index: z.number(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('response.reasoning_summary_text.done'),
    item_id: z.string(),
    output_index: z.number(),
    content_index: z.number(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.record(z.string(), z.unknown()),
  }),
])
export type OpenAIResponsesStreamEvent = z.infer<
  typeof OpenAIResponsesStreamEventSchema
>
