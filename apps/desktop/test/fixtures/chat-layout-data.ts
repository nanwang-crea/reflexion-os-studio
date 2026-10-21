import type { ComponentProps } from 'react'
import type { ChatView } from '../../frontend/features/chat/ChatView'

type ChatProps = ComponentProps<typeof ChatView>

export const approval: ChatProps['pendingApprovals'][number] = {
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
}

export const interaction: ChatProps['pendingInteractions'][number] = {
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
}
