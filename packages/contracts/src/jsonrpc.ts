import { z } from 'zod'

export const JsonRpcIdSchema = z.union([z.string(), z.number()])
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>

export const JsonRpcErrorDetailSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
})
export type JsonRpcErrorDetail = z.infer<typeof JsonRpcErrorDetailSchema>

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.nullable(),
  result: z.unknown().optional(),
  error: JsonRpcErrorDetailSchema.optional(),
})

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcNotificationSchema,
])

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>

export const ProtocolEnvelopeSchema = JsonRpcMessageSchema
export type ProtocolEnvelope = JsonRpcMessage
