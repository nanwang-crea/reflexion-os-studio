import { z } from 'zod'

export const RuntimeErrorCodeSchema = z.enum([
  'configuration',
  'authentication',
  'rate_limit',
  'timeout',
  'network',
  'unsupported',
  'provider',
  'invalid_request',
  'internal',
  // 子 Run 安全边界触发：父 Run 取消是 cancelled，超时/token 预算用稳定错误码失败。
  'child_timeout',
  'child_token_budget',
  // Agent Loop Hardening：完成状态机的稳定停止原因（统一映射为 failed + errorCode）。
  'max_turns',
  'output_truncated',
  'content_filtered',
  'provider_protocol',
  'no_progress',
  'run_timeout',
  'run_token_budget',
  'tool_call_budget',
])
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>

export const RuntimeErrorSchema = z.object({
  code: RuntimeErrorCodeSchema,
  message: z.string(),
  data: z.unknown().optional(),
})
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>
