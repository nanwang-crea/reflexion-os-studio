import {
  AskUserInputSchema,
  type JsonValue,
  type UserQuestionAnswer,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from './shared.js'

const PARAMETERS: JsonValue = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'header', 'question', 'options'],
        properties: {
          id: { type: 'string', minLength: 1 },
          header: { type: 'string', minLength: 1, maxLength: 40 },
          question: { type: 'string', minLength: 1, maxLength: 500 },
          multiSelect: { type: 'boolean' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'description'],
              properties: {
                id: { type: 'string', minLength: 1 },
                label: { type: 'string', minLength: 1, maxLength: 80 },
                description: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 300,
                },
              },
            },
          },
        },
      },
    },
  },
}

export function createAskUserTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'ask_user',
    description:
      '仅在缺少一个必须由用户决定、且会实质改变后续工作的选择时提问。每题提供 2-3 个互斥选项；推荐项放第一项并在标签末尾写“（推荐）”。用户始终可填写自定义答案。不要询问可从代码、上下文或合理默认值自行确定的问题。',
    parameters: PARAMETERS,
    execution: { effect: 'state', idempotent: false },
    async execute({ args, signal, toolCallId }) {
      const input = AskUserInputSchema.parse(args)
      const answers = await ctx.interactions.requestQuestions({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        toolCallId,
        questions: input.questions,
        emitter: ctx.emitter,
        signal,
      })
      return {
        content: formatAnswers(input.questions, answers),
        isError: false,
        data: { answers } as JsonValue,
      }
    },
  }
}

export function formatAnswers(
  questions: { id: string; question: string }[],
  answers: UserQuestionAnswer[],
): string {
  if (answers.length === 0) {
    return '用户跳过了所有问题。请使用最佳判断继续，不要虚构用户偏好。'
  }
  const labels = new Map(questions.map((item) => [item.id, item.question]))
  return answers
    .map((answer) => {
      const values = [
        ...answer.selectedOptionIds,
        ...(answer.customText ? [answer.customText] : []),
      ]
      return `${labels.get(answer.questionId) ?? answer.questionId}: ${values.join(', ')}`
    })
    .join('\n')
}
