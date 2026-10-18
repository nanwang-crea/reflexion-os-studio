import { z } from 'zod'
import {
  AgentBrowserPageSchema,
  AgentBrowserUrlSchema,
  AgentBrowserPageExample,
} from '../agent.js'

const text = z.string().max(10000)
export const BrowserTargetSchema = z.union([
  z.strictObject({
    ref: z
      .string()
      .regex(/^(?:f\d+)?e\d+$/)
      .max(32),
    name: text.min(1).max(200),
  }),
  z.strictObject({
    role: z.enum([
      'button',
      'link',
      'textbox',
      'searchbox',
      'combobox',
      'checkbox',
      'radio',
      'tab',
      'menuitem',
      'option',
      'slider',
      'listitem',
      'heading',
      'region',
      'dialog',
    ]),
    name: text.min(1).max(200),
  }),
])
export const BrowserStepSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('click'),
    target: BrowserTargetSchema,
    button: z.enum(['left', 'right']).default('left'),
    count: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.strictObject({
    action: z.literal('type'),
    target: BrowserTargetSchema,
    text,
    submit: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal('hover'), target: BrowserTargetSchema }),
  z.strictObject({ action: z.literal('reveal'), target: BrowserTargetSchema }),
  z.strictObject({
    action: z.literal('press'),
    target: BrowserTargetSchema,
    key: z.enum([
      'Enter',
      'Tab',
      'Shift+Tab',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Backspace',
      'Delete',
      'Space',
      'ControlOrMeta+A',
    ]),
  }),
  z.strictObject({
    action: z.literal('select'),
    target: BrowserTargetSchema,
    values: z.array(text).min(1).max(10),
  }),
  z.strictObject({
    action: z.literal('drag'),
    source: BrowserTargetSchema,
    target: BrowserTargetSchema,
  }),
  z.strictObject({
    action: z.literal('scroll'),
    target: BrowserTargetSchema.optional(),
    deltaX: z.number().int().min(-5000).max(5000).default(0),
    deltaY: z.number().int().min(-5000).max(5000).default(600),
  }),
  z.strictObject({
    action: z.literal('screenshot'),
    fullPage: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({ action: z.literal('goto'), url: AgentBrowserUrlSchema }),
  z.strictObject({
    action: z.literal('wait'),
    milliseconds: z.number().int().min(0).max(2000),
  }),
])
const common = {
  page: AgentBrowserPageSchema,
  timeoutMs: z.number().int().min(1000).max(20000).default(20000),
}
export const BrowserPlanSchema = z
  .strictObject({
    ...common,
    mode: z.literal('actions'),
    steps: z.array(BrowserStepSchema).min(1).max(20),
  })
  .superRefine((plan, ctx) => {
    if (plan.steps.filter((step) => step.action === 'screenshot').length > 4)
      ctx.addIssue({
        code: 'custom',
        message: '最多4张截图',
      })
  })
const BrowserScriptSchema = z.strictObject({
  ...common,
  mode: z.literal('script'),
  script: z.string().min(1).max(20000),
})
export const BrowserExecuteSchema = z.discriminatedUnion('mode', [
  BrowserPlanSchema,
  BrowserScriptSchema,
])
export type BrowserStep = z.infer<typeof BrowserStepSchema>
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>
function inputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    io: 'input',
    override: ({ jsonSchema }) => {
      delete jsonSchema.format
    },
  })
}
export const BrowserExecuteJsonSchema = inputJsonSchema(BrowserExecuteSchema)
BrowserExecuteJsonSchema.type = 'object'
// 与分支使用同一 Zod 字段，兼容只读取顶层 properties 的模型服务。
BrowserExecuteJsonSchema.properties = {
  ...inputJsonSchema(BrowserPlanSchema).properties,
  ...inputJsonSchema(BrowserScriptSchema).properties,
  mode: inputJsonSchema(
    z.enum([
      BrowserPlanSchema.shape.mode.value,
      BrowserScriptSchema.shape.mode.value,
    ]),
  ),
}
BrowserExecuteJsonSchema.required = ['page', 'mode']
BrowserExecuteJsonSchema.description =
  '完整 arguments 必须包含 page 和 mode。page 复制最近导航/读取返回的真实 page（不要使用示例 ID）；mode=actions 时传 steps，mode=script 时传 script，两种格式不能混用。脚本仅支持工具说明列出的语法，不能当作任意 Playwright/JavaScript 执行器。'
BrowserExecuteJsonSchema.examples = [
  BrowserExecuteSchema.parse({
    page: AgentBrowserPageExample,
    mode: 'actions',
    steps: [
      { action: 'click', target: { role: 'button', name: '搜索' } },
      { action: 'read' },
    ],
  }),
  BrowserExecuteSchema.parse({
    page: AgentBrowserPageExample,
    mode: 'script',
    script: "await page.getByRole('button', { name: '搜索' }).click();",
  }),
]
export const BrowserPlanJsonSchema = inputJsonSchema(BrowserPlanSchema)
