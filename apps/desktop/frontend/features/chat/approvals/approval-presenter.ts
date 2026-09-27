import type {
  ApprovalChoice,
  ApprovalContextView,
  ApprovalRisk,
  ApprovalSubject,
} from '@reflexion-os-studio/runtime-client'
import type { PendingApproval } from '../../../hooks/permissions/usePendingApprovals'

/**
 * 审批协议 → 展示模型的纯函数（features/chat/approvals/ 组件只消费本模型）。
 * 所有文本都是 Runtime 已脱敏的展示字段；组件不得回退到 args 原文。
 */

export interface ApprovalDisplay {
  /** 操作名称（标题后缀）。 */
  actionLabel: string
  /** 风险标题：状态词 + 操作名。颜色之外必有文字区分（无障碍红线）。 */
  riskTitle: string
  /** 风险等级 → 视觉 class 与状态图标名。 */
  risk: ApprovalRisk
  /** 操作主体：文件路径或 Shell 命令（等宽展示）。 */
  subject: { kind: 'path' | 'command' | 'text'; value: string } | null
  /** 规则说明：存在会话 choice 时写明"本会话将允许什么"。 */
  ruleNote: string | null
  /** 关键范围短标签（无值不占位）。 */
  chips: string[]
  /** 低频技术信息（默认收起的"查看详情"）。 */
  details: { label: string; value: string }[]
  /** Runtime 下发的可选动作（前端不得增删语义，只渲染）。 */
  choices: ApprovalChoice[]
  context: ApprovalContextView | null
  fallbackSummary: string
}

const OPERATION_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.glob': '查找文件',
  'file.grep': '搜索内容',
  'file.write': '写入文件',
  'file.write_stream': '分块写入文件',
  'file.edit': '编辑文件',
  'file.delete': '删除文件',
  'file.move': '移动文件',
  'file.mkdir': '创建目录',
  'shell.execute': '执行命令',
  sandbox_network: '命令联网',
}

const RISK_TITLES: Record<ApprovalRisk, string> = {
  normal: '需要批准',
  warning: '需要批准 · 谨慎操作',
  elevated: '需要批准 · 高权限范围',
  'danger-confirm': '危险能力确认',
}

export function actionLabelFor(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation
}

function chipsFor(
  context: ApprovalContextView | null,
  operation: string,
): string[] {
  const chips: string[] = []
  if (context === null) return chips
  if (context.agent) {
    chips.push(
      context.agent.depth === 0
        ? 'Primary Agent'
        : `${context.agent.displayName} · 第 ${context.agent.depth} 层`,
    )
  }
  if (context.displayCwd !== null) chips.push(`工作目录 ${context.displayCwd}`)
  if (operation.startsWith('file.')) {
    chips.push(context.workspaceScope === 'inside' ? '工作区内' : '无工作区')
  }
  if (context.sandbox === 'read-only') chips.push('沙箱只读')
  else if (context.sandbox === 'workspace-write') chips.push('工作区可写')
  else if (context.sandbox === 'escalated') chips.push('提权：工作区外路径')
  else if (context.sandbox === 'danger') chips.push('Danger 系统范围')
  chips.push(context.network ? '将联网' : '不联网')
  if (context.escalation) chips.push('将访问工作区外')
  if (context.sandboxProvider) chips.push(`沙箱 ${context.sandboxProvider}`)
  return chips
}

function subjectOf(
  subject: ApprovalSubject | undefined,
  fallbackSummary: string,
  operation: string,
): ApprovalDisplay['subject'] {
  if (subject === undefined) {
    // 降级事件（无 subject）：summary 形如 `<operation>: <path|command>`，
    // 剥掉操作前缀后按资源形态归类，保持与 V2 卡面一致的主体展示。
    const prefix = `${operation}: `
    if (fallbackSummary.startsWith(prefix)) {
      const rest = fallbackSummary.slice(prefix.length)
      if (operation === 'shell.execute') return { kind: 'command', value: rest }
      if (operation.startsWith('file.')) return { kind: 'path', value: rest }
    }
    return { kind: 'text', value: fallbackSummary }
  }
  switch (subject.kind) {
    case 'workspace-path':
      return { kind: 'path', value: subject.path }
    case 'shell-command':
      return { kind: 'command', value: subject.displayCommand }
    case 'operation': {
      const match = /^([^:]+):\s*(.+)$/.exec(fallbackSummary)
      if (
        match !== null &&
        (match[2]?.startsWith('/') || match[2]?.includes(' → '))
      ) {
        return { kind: 'path', value: match[2] }
      }
      return { kind: 'text', value: fallbackSummary }
    }
  }
}

function ruleNoteFor(choices: ApprovalChoice[]): string | null {
  const session = choices.find((c) => c.presentation === 'session-menu')
  if (session === undefined) return null
  const description = session.description ?? '（范围以该选项说明为准）'
  return `本会话可记住：${session.label} —— ${description}`
}

const SANDBOX_NAMES: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  escalated: '提权',
  danger: 'Danger',
}

export function presentApproval(approval: PendingApproval): ApprovalDisplay {
  const choices: ApprovalChoice[] =
    approval.choices && approval.choices.length > 0
      ? approval.choices
      : [
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
        ]
  const risk: ApprovalRisk = approval.risk ?? 'normal'
  const details: ApprovalDisplay['details'] = []
  if (approval.context) {
    if (approval.context.agent) {
      details.push({
        label: '执行 Agent',
        value: `${approval.context.agent.displayName} · 第 ${approval.context.agent.depth} 层`,
      })
      details.push({
        label: '根任务',
        value: approval.context.agent.rootTask,
      })
    }
    if (approval.context.justification) {
      details.push({ label: '理由', value: approval.context.justification })
    }
    if (
      approval.subject?.kind === 'shell-command' &&
      approval.subject.escalation
    ) {
      details.push({
        label: '提权',
        value:
          '本命令获批后将解除工作区写边界（仅限卡面列出的目标路径，机密路径除外）',
      })
    }
    if (approval.subject?.kind === 'shell-command') {
      details.push({
        label: '可复用前缀',
        value:
          approval.subject.prefixCandidate === null
            ? '无（复合/展开命令只能允许一次）'
            : approval.subject.prefixCandidate.join(' '),
      })
    }
  }
  details.push({
    label: '调用',
    value: `${approval.operation} · ${approval.toolCallId.slice(-8)}`,
  })
  return {
    actionLabel: actionLabelFor(approval.operation),
    riskTitle: RISK_TITLES[risk],
    risk,
    subject: subjectOf(approval.subject, approval.summary, approval.operation),
    ruleNote: ruleNoteFor(choices),
    chips: chipsFor(approval.context ?? null, approval.operation),
    details,
    choices,
    context: approval.context ?? null,
    fallbackSummary: approval.summary,
  }
}

export function sandboxName(policy: string): string {
  return SANDBOX_NAMES[policy] ?? policy
}
