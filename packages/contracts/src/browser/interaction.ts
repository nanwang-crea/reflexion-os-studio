import { z } from 'zod'
import { AgentBrowserPageSchema } from './agent.js'

/** Reject credential-shaped input before tool arguments enter persisted history. */
export function isSafeBrowserText(text: string): boolean {
  return !/-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)|(?:password|passwd|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key|authorization|密码|密钥|令牌)\s*[=:：]\s*\S+|\b(?:bearer|basic)\s+[A-Za-z0-9+/=._~-]{8,}|\b[A-Za-z0-9+/_-]{40,}={0,2}\b|(?:\d[ -]?){13,19}/i.test(
    text,
  )
}
export const AgentBrowserTargetSchema = z.strictObject({
  page: AgentBrowserPageSchema,
  ref: z
    .string()
    .max(32)
    .regex(/^(?:f\d+)?e\d+$/)
    .describe(
      '必须来自最近一次 browser.read 快照的 ref，不接受 CSS、XPath 或脚本',
    ),
  element: z
    .string()
    .trim()
    .refine(isSafeBrowserText)
    .min(1)
    .max(200)
    .describe('快照中目标控件的精确名称；无名称时填写角色名，供审批与执行核对'),
})
export const AgentBrowserClickSchema = AgentBrowserTargetSchema
export const AgentBrowserTypeSchema = AgentBrowserTargetSchema.extend({
  text: z
    .string()
    .max(10000)
    .refine(isSafeBrowserText)
    .describe('普通文本；禁止密码、验证码、密钥、支付信息和其他凭据'),
  submit: z
    .boolean()
    .default(false)
    .describe(
      '填写后是否在该控件按 Enter；仅支持同源 GET 搜索，不允许 POST 或跨站提交',
    ),
})
export type AgentBrowserClick = z.infer<typeof AgentBrowserClickSchema>
export type AgentBrowserType = z.infer<typeof AgentBrowserTypeSchema>

export const AgentBrowserClickJsonSchema = z.toJSONSchema(
  AgentBrowserClickSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
export const AgentBrowserTypeJsonSchema = z.toJSONSchema(
  AgentBrowserTypeSchema,
  {
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
