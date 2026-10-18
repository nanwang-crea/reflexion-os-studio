import { z } from 'zod'
import { AgentBrowserPageSchema, AgentBrowserPageExample } from './agent.js'

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
    .describe('目标控件的描述，供审批展示；执行使用快照 ref 定位'),
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
    .describe('填写后是否在该控件按 Enter；允许普通表单提交和页面跳转'),
})
export type AgentBrowserClick = z.infer<typeof AgentBrowserClickSchema>
export type AgentBrowserType = z.infer<typeof AgentBrowserTypeSchema>

export const AgentBrowserClickJsonSchema = z.toJSONSchema(
  AgentBrowserClickSchema,
  {
    io: 'input',
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)
export const AgentBrowserTypeJsonSchema = z.toJSONSchema(
  AgentBrowserTypeSchema,
  {
    io: 'input',
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  },
)

AgentBrowserClickJsonSchema.description =
  '必须传 page、ref、element；page 和 ref 来自最新 browser.read，element 是给用户看的控件描述。'
AgentBrowserClickJsonSchema.examples = [
  AgentBrowserClickSchema.parse({
    page: AgentBrowserPageExample,
    ref: 'e1',
    element: '搜索按钮',
  }),
]
AgentBrowserTypeJsonSchema.description =
  '必须传 page、ref、element、text；page/ref 来自最新读取。submit=true 会按 Enter，请先确认是否需要提交。'
AgentBrowserTypeJsonSchema.examples = [
  AgentBrowserTypeSchema.parse({
    page: AgentBrowserPageExample,
    ref: 'e1',
    element: '搜索框',
    text: '北京旅游',
    submit: true,
  }),
]
