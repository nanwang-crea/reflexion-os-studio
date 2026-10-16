import { z } from 'zod'
import { isSafeBrowserText } from '../interaction.js'
import { AgentBrowserPageSchema, AgentBrowserUrlSchema } from '../agent.js'

const text = z.string().max(10000).refine(isSafeBrowserText)
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
    if (
      plan.steps.filter((step) => step.action === 'screenshot').length > 4 ||
      plan.steps.some(
        (step) =>
          step.action === 'goto' &&
          new URL(step.url).origin !== plan.page.origin,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: '最多4张截图，导航必须保持在当前获准来源',
      })
  })
export const BrowserExecuteSchema = z.discriminatedUnion('mode', [
  BrowserPlanSchema,
  z.strictObject({
    ...common,
    mode: z.literal('script'),
    script: z.string().min(1).max(20000).refine(isSafeBrowserText),
  }),
])
export type BrowserStep = z.infer<typeof BrowserStepSchema>
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>
export const BrowserExecuteJsonSchema = z.toJSONSchema(BrowserExecuteSchema, {
  io: 'input',
  override: ({ jsonSchema }) => {
    delete jsonSchema.format
  },
})
BrowserExecuteJsonSchema.type = 'object'
export const BrowserPlanJsonSchema = z.toJSONSchema(BrowserPlanSchema, {
  io: 'input',
  override: ({ jsonSchema }) => {
    delete jsonSchema.format
  },
})
