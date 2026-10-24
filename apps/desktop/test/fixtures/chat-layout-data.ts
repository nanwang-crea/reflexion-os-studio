import type { Plan, RuntimeEvent } from '@reflexion-os-studio/runtime-client'

type EventPayload<T extends RuntimeEvent['type']> = Omit<
  Extract<RuntimeEvent, { type: T }>,
  'type' | 'protocolVersion' | 'eventId' | 'scope' | 'seq' | 'occurredAt'
>

export const plan: Plan = {
  id: 'plan',
  sessionId: 's',
  messageId: null,
  goal: '验证待处理区域的动态布局',
  status: 'active',
  summary: null,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  completedAt: null,
  steps: [],
}

export const approval = {
  runId: 'r',
  toolCallId: 'tool',
  operation: 'file.edit',
  summary: '更新工作区文件',
  subject: {
    kind: 'workspace-path',
    operation: 'file.edit',
    path: 'src/example.ts',
  },
  risk: 'normal',
  context: {
    displayCwd: 'synthetic/project',
    workspaceScope: 'inside',
    permissionPreset: 'workspace-read',
    approvalReason: 'preset-policy',
    sandbox: 'workspace-write',
    sandboxProvider: 'seatbelt',
    network: false,
    escalation: false,
    justification: null,
  },
  choices: [
    {
      id: 'allow-once',
      decision: 'approved',
      presentation: 'primary',
      label: '允许一次',
    },
    {
      id: 'deny',
      decision: 'denied',
      presentation: 'secondary',
      label: '拒绝',
    },
  ],
} satisfies EventPayload<'approval.required'>

export const interaction = {
  runId: 'r',
  toolCallId: 'question-tool',
  interactionId: 'question',
  sessionId: 's',
  kind: 'user_question',
  questions: [
    {
      id: 'q',
      header: '布局选项',
      question: '选择需要处理的内容',
      multiSelect: false,
      options: Array.from({ length: 10 }, (_, i) => ({
        id: `option-${i}`,
        label: `选项 ${i}`,
        description: '用于验证很长的问题与操作按钮仍然可访问。'.repeat(3),
      })),
    },
  ],
} satisfies EventPayload<'interaction.required'>
