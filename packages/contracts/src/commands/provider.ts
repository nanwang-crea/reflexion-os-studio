import { z } from 'zod'
import {
  ProviderCapabilitySchema,
  ProviderProfileSchema,
  ApiFormatSchema,
  ProviderHeadersSchema,
} from '../entities.js'
import { RequestIdSchema } from './params.js'

export const providerCommands = {
  'provider.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ profiles: z.array(ProviderProfileSchema) }),
  },
  'provider.configure': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      baseUrl: z.url(),
      models: z.array(z.string().min(1)).min(1),
      // 只写字段：明文 Key 仅在请求中出现一次，runtime 落入本地 secret 存储，
      // profile 只返回 secretRef。任何响应/事件/日志不得包含 secret。
      secret: z.string().min(1).optional(),
      // 编辑且不换 Key 时必须回传既有 secretRef。
      secretRef: z.string().min(1).optional(),
      // 供应商能力类型；省略时编辑保留原值、新建为 ['chat']。
      capabilities: z.array(ProviderCapabilitySchema).optional(),
      // API 协议格式；省略时编辑保留原值、新建为 'openai-chat'。
      apiFormat: ApiFormatSchema.optional(),
      // 附加请求头；禁止覆盖 Runtime 管理的鉴权与 Content-Type。
      headers: ProviderHeadersSchema.optional(),
      // 对话默认采样参数；省略=保留原值，null=清空回未配置。
      temperature: z.number().min(0).max(2).nullable().optional(),
      maxTokens: z.number().int().positive().nullable().optional(),
      // 模型上下文窗口（token 数）；省略=保留原值，null=清空。
      contextWindow: z.number().int().positive().nullable().optional(),
      // 上下文预算上限（token 数）；省略=保留原值，null=清空(默认 64k)。
      contextBudget: z.number().int().positive().nullable().optional(),
      enabled: z.boolean().optional(),
    }),
    result: z.object({ profile: ProviderProfileSchema }),
  },
  'provider.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'provider.test': {
    params: z.object({
      requestId: RequestIdSchema,
      baseUrl: z.url(),
      model: z.string().min(1),
      // 测试请求的明文 Key 只在内存中使用一次，不落盘。
      secret: z.string().min(1).optional(),
      secretRef: z.string().min(1).optional(),
      // API 协议格式；省略时默认 'openai-chat'。
      apiFormat: ApiFormatSchema.optional(),
      headers: ProviderHeadersSchema.optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      model: z.string().min(1),
      error: z.string().nullable(),
    }),
  },
}
