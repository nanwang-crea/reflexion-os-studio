import { z } from 'zod'
import { JsonValueSchema } from './json-value.js'
import { PlanSnapshotSchema } from './plan-documents.js'
import { AgentContextSchema } from './permissions.js'

export const UserQuestionOptionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('选项 ID，在所属问题内唯一；不能代替问题本身的 id'),
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
})
export type UserQuestionOption = z.infer<typeof UserQuestionOptionSchema>

const QuestionFieldsSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      '问题自身的稳定 ID，必须放在 questions 每项上，例如 login_choice；不是 options[].id',
    ),
  header: z.string().min(1).max(40),
  question: z.string().min(1).max(500),
  multiSelect: z.boolean().default(false),
  options: z.array(UserQuestionOptionSchema).min(2).max(3),
})
function uniqueOptions(
  question: z.infer<typeof QuestionFieldsSchema>,
  context: z.RefinementCtx,
) {
  if (
    new Set(question.options.map((option) => option.id)).size <
    question.options.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'option ids must be unique within a question',
    })
  }
}
export const UserQuestionSchema = QuestionFieldsSchema.extend({
  plan: PlanSnapshotSchema.optional(),
}).superRefine(uniqueOptions)
const AskUserQuestionSchema = QuestionFieldsSchema.extend({
  options: z.array(UserQuestionOptionSchema.strict()).min(2).max(3),
})
  .strict()
  .superRefine(uniqueOptions)
export type UserQuestion = z.infer<typeof UserQuestionSchema>

export const UserQuestionAnswerSchema = z
  .object({
    questionId: z.string().min(1),
    selectedOptionIds: z.array(z.string().min(1)).max(3),
    keepPlan: z.boolean().optional(),
    customText: z.string().trim().min(1).max(1000).optional(),
  })
  .refine(
    (answer) =>
      answer.selectedOptionIds.length > 0 || answer.customText !== undefined,
    { message: 'answer must select an option or provide custom text' },
  )
export type UserQuestionAnswer = z.infer<typeof UserQuestionAnswerSchema>

export const AskUserInputSchema = z
  .strictObject({
    questions: z.array(AskUserQuestionSchema).min(1).max(3),
  })
  .superRefine((input, context) => {
    if (
      new Set(input.questions.map((question) => question.id)).size <
      input.questions.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'question ids must be unique',
      })
    }
  })
export type AskUserInput = z.infer<typeof AskUserInputSchema>

export const AskUserParameters = JsonValueSchema.parse({
  ...z.toJSONSchema(AskUserInputSchema, { io: 'input' }),
  description:
    'questions 每项必须同时包含问题 id、header、question、options；每个选项也必须有独立 id、label、description。选项 id 不会替代问题 id。按具体字段修正，不要猜测编码或传输错误。',
  examples: [
    AskUserInputSchema.parse({
      questions: [
        {
          id: 'continue_choice',
          header: '继续方式',
          question: '您希望如何继续？',
          options: [
            {
              id: 'continue',
              label: '继续当前任务（推荐）',
              description: '按当前方向继续。',
            },
            {
              id: 'adjust',
              label: '调整方向',
              description: '先根据您的补充调整目标。',
            },
          ],
        },
      ],
    }),
  ],
})

export const InteractionKindSchema = z.enum(['user_question', 'plan_approval'])
export type InteractionKind = z.infer<typeof InteractionKindSchema>

export const UserInteractionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  kind: InteractionKindSchema,
  questions: z.array(UserQuestionSchema).min(1).max(3),
  answers: z.array(UserQuestionAnswerSchema).max(3).nullable(),
  status: z.enum(['pending', 'resolved', 'cancelled']),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).nullable(),
  // 运行时由 Run/Delegation canonical 数据投影；旧记录可缺省。
  agent: AgentContextSchema.optional(),
})
export type UserInteraction = z.infer<typeof UserInteractionSchema>

export const UserInteractionResponseSchema = z.object({
  interactionId: z.string().min(1),
  answers: z.array(UserQuestionAnswerSchema).max(3),
})
export type UserInteractionResponse = z.infer<
  typeof UserInteractionResponseSchema
>
