import { z } from 'zod'

export const UserQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
})
export type UserQuestionOption = z.infer<typeof UserQuestionOptionSchema>

export const UserQuestionSchema = z
  .object({
    id: z.string().min(1),
    header: z.string().min(1).max(40),
    question: z.string().min(1).max(500),
    multiSelect: z.boolean().default(false),
    options: z.array(UserQuestionOptionSchema).min(2).max(3),
  })
  .superRefine((question, context) => {
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
  })
export type UserQuestion = z.infer<typeof UserQuestionSchema>

export const UserQuestionAnswerSchema = z
  .object({
    questionId: z.string().min(1),
    selectedOptionIds: z.array(z.string().min(1)).max(3),
    customText: z.string().trim().min(1).max(1000).optional(),
  })
  .refine(
    (answer) =>
      answer.selectedOptionIds.length > 0 || answer.customText !== undefined,
    { message: 'answer must select an option or provide custom text' },
  )
export type UserQuestionAnswer = z.infer<typeof UserQuestionAnswerSchema>

export const AskUserInputSchema = z
  .object({
    questions: z.array(UserQuestionSchema).min(1).max(3),
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
  status: z.enum(['pending', 'resolved']),
  createdAt: z.string().min(1),
  resolvedAt: z.string().min(1).nullable(),
})
export type UserInteraction = z.infer<typeof UserInteractionSchema>

export const UserInteractionResponseSchema = z.object({
  interactionId: z.string().min(1),
  answers: z.array(UserQuestionAnswerSchema).max(3),
})
export type UserInteractionResponse = z.infer<
  typeof UserInteractionResponseSchema
>
