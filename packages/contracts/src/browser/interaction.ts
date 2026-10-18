import { z } from 'zod'
import { AgentBrowserPageSchema } from './agent.js'

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
    .min(1)
    .max(200)
    .describe('快照中目标控件的精确名称；无名称时填写角色名，供审批与执行核对'),
})
export const AgentBrowserClickSchema = AgentBrowserTargetSchema
export const AgentBrowserTypeSchema = AgentBrowserTargetSchema.extend({
  text: z
    .string()
    .max(10000)
    .describe('填写的文本内容，将随完整操作计划提交审批'),
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
