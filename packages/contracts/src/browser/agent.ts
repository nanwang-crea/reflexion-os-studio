import { z } from 'zod'

export function isSafeAgentBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    let decoded = url.pathname + url.search + url.hash
    for (let depth = 0; depth < 4 && /%[a-f\d]{2}/i.test(decoded); ++depth)
      decoded = decodeURIComponent(decoded)
    if (/%[a-f\d]{2}/i.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded))
      return false
    return (
      value.length <= 2048 &&
      !/[\u0000-\u0020\u007f]/.test(value) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
export const AgentBrowserUrlSchema = z
  .string()
  .max(2048)
  .refine(
    isSafeAgentBrowserUrl,
    '请使用不含用户名/密码的完整 HTTP(S) URL，不支持 file: 等协议或控制字符',
  )
export const AgentBrowserPageSchema = z.strictObject({
  tabId: z
    .uuid()
    .describe(
      '复制 browser.navigate 或 browser.read 返回的 page.tabId，不要自行生成',
    ),
  origin: z.url().refine((value) => new URL(value).origin === value),
  pageVersion: z
    .uuid()
    .describe('复制返回的 page.pageVersion；控件操作前读取最新快照'),
})
export type AgentBrowserPage = z.infer<typeof AgentBrowserPageSchema>
export const AgentBrowserNavigateSchema = z.strictObject({
  url: AgentBrowserUrlSchema,
  from: AgentBrowserPageSchema.optional(),
})
export const AgentBrowserDocumentSchema = z.strictObject({
  page: AgentBrowserPageSchema,
  sourceUrl: AgentBrowserUrlSchema,
  title: z.string().max(300),
  snapshot: z.string().max(50000).optional(),
  truncated: z.boolean(),
  injectionWarning: z.boolean(),
})
export type AgentBrowserDocument = z.infer<typeof AgentBrowserDocumentSchema>
export const AgentBrowserOperationSchema = z.enum([
  'browser.navigate',
  'browser.read',
  'browser.close',
  'browser.click',
  'browser.type',
  'browser.execute',
])

export const AgentBrowserPageExample = AgentBrowserPageSchema.parse({
  tabId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://example.com',
  pageVersion: '22222222-2222-4222-8222-222222222222',
})

export const AgentBrowserNavigateJsonSchema = z.toJSONSchema(
  AgentBrowserNavigateSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
export const AgentBrowserPageJsonSchema = z.toJSONSchema(
  AgentBrowserPageSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)

AgentBrowserNavigateJsonSchema.description =
  '必须传 url；首次导航不要编造 from。地址使用纯 URL，不要传 Markdown 链接。'
AgentBrowserNavigateJsonSchema.examples = [{ url: 'https://example.com/' }]
AgentBrowserPageJsonSchema.description =
  'browser.read/close 在顶层直接传 tabId、origin、pageVersion，复制最近返回的 page 三个字段；不要再嵌套一层 page。示例 ID 不能用于真实调用。'
AgentBrowserPageJsonSchema.examples = [AgentBrowserPageExample]
