import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'

/**
 * Skill manifest（元数据，不含 instructions 正文）。
 * Phase 1A 只允许内置 Skill；第三方安装/启停/Registry 属 Phase 2。
 * tools 为该 Skill 约定使用的工具名（信息性；实际可用性仍由 Run 装配与权限策略决定）。
 */
export const ProviderCapabilitySchema = z.enum([
  'chat',
  'embedding',
  'image',
  'video',
])
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>

/** API 协议格式：决定请求/响应的序列化与流式解析方式。 */
export const ApiFormatSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic',
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_PROVIDER_HEADERS = new Set([
  'authorization',
  'content-type',
  'x-api-key',
])

export const ProviderHeaderSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(HTTP_HEADER_NAME, '请求头名称格式无效')
    .refine(
      (name) => !RESERVED_PROVIDER_HEADERS.has(name.toLowerCase()),
      '该请求头由 ReflexionOS 管理，不能覆盖',
    ),
  value: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !/[\r\n]/.test(value), '请求头值不能包含换行符'),
})
export type ProviderHeader = z.infer<typeof ProviderHeaderSchema>

export const ProviderHeadersSchema = z
  .array(ProviderHeaderSchema)
  .max(32)
  .superRefine((headers, context) => {
    const names = new Set<string>()
    headers.forEach((header, index) => {
      const normalized = header.name.toLowerCase()
      if (names.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: '请求头名称不能重复（不区分大小写）',
        })
      }
      names.add(normalized)
    })
  })

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.url(),
  // 该供应商下可选的模型列表；对话时可指定其中一个。
  models: z.array(z.string().min(1)).min(1),
  // 供应商提供的能力类型；决定该 Provider 可参与的负载（对话/向量/生图/生视频）。
  capabilities: z.array(ProviderCapabilitySchema),
  secretRef: z.string().min(1),
  enabled: z.boolean(),
  // API 协议格式；缺失时向后兼容为 'openai-chat'。
  apiFormat: ApiFormatSchema.optional(),
  /** 附加请求头；鉴权与 Content-Type 仍由 Runtime 管理。 */
  headers: ProviderHeadersSchema,
  // 对话默认采样参数；null 表示未配置（沿用服务端默认）。
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().positive().nullable(),
  // 模型上下文窗口（token 数）；null 表示未知，Runtime 用保守默认预算。
  contextWindow: z.number().int().positive().nullable(),
  // 上下文预算上限（token 数）；null 表示用默认(64k)。
  contextBudget: z.number().int().positive().nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>
