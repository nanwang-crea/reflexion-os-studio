import { z } from 'zod'
import { JsonValueSchema } from '../json-value.js'

/** 必须原样回传的供应商块；与 UI 展示的 reasoning 文本分开保存。 */
export const AnthropicReplayBlockSchema = z.union([
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().min(1),
    })
    .catchall(JsonValueSchema),
  z
    .object({ type: z.literal('redacted_thinking'), data: z.string() })
    .catchall(JsonValueSchema),
  z
    .object({ type: z.literal('text'), text: z.string() })
    .catchall(JsonValueSchema),
  z
    .object({
      type: z.literal('tool_use'),
      id: z.string().min(1),
      name: z.string(),
      input: z.record(z.string(), JsonValueSchema),
    })
    .catchall(JsonValueSchema),
])
export type AnthropicReplayBlock = z.infer<typeof AnthropicReplayBlockSchema>

export const ResponsesReplayItemSchema = z.union([
  z
    .object({
      type: z.literal('reasoning'),
      id: z.string().min(1),
      summary: z.array(z.record(z.string(), JsonValueSchema)),
      encrypted_content: z.string().nullable().optional(),
    })
    .catchall(JsonValueSchema),
  z
    .object({
      type: z.literal('message'),
      role: z.literal('assistant'),
      content: z.array(z.record(z.string(), JsonValueSchema)),
    })
    .catchall(JsonValueSchema),
  z
    .object({
      type: z.literal('function_call'),
      call_id: z.string().min(1),
      name: z.string(),
      arguments: z.string(),
    })
    .catchall(JsonValueSchema),
])
export type ResponsesReplayItem = z.infer<typeof ResponsesReplayItemSchema>

const source = { baseUrl: z.string(), model: z.string() }
export const ProviderContinuationSchema = z.discriminatedUnion('apiFormat', [
  z.object({
    apiFormat: z.literal('anthropic'),
    ...source,
    blocks: z.array(AnthropicReplayBlockSchema),
  }),
  z.object({
    apiFormat: z.literal('openai-responses'),
    ...source,
    items: z.array(ResponsesReplayItemSchema),
  }),
])
export type ProviderContinuation = z.infer<typeof ProviderContinuationSchema>
