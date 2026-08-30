import type { PendingApproval } from '../../hooks/useAppBootstrap'

const OPERATION_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.write': '写入文件',
  'shell.execute': '执行命令',
}

interface ApprovalCardProps {
  approval: PendingApproval
  onResolve: (
    toolCallId: string,
    decision: 'approved' | 'denied',
    scope: 'once' | 'session',
  ) => void
}

/**
 * 工具审批卡：Agent 请求执行 ask 级操作时出现；
 * Allow once / Allow for session / Deny 三种决策对齐 PERMISSION-MODEL。
 */
export function ApprovalCard(props: ApprovalCardProps): React.JSX.Element {
  const { approval, onResolve } = props
  const resolve = (
    decision: 'approved' | 'denied',
    scope: 'once' | 'session',
  ): void => {
    onResolve(approval.toolCallId, decision, scope)
  }
  return (
    <div className="approval-card" role="alertdialog" aria-label="工具操作审批">
      <div className="approval-head">
        <span className="approval-title">
          Agent 请求执行：
          {OPERATION_LABELS[approval.operation] ?? approval.operation}
        </span>
      </div>
      <code className="approval-summary">{approval.summary}</code>
      <div className="approval-actions">
        <button className="ghost" onClick={() => resolve('approved', 'once')}>
          允许一次
        </button>
        <button
          className="ghost"
          onClick={() => resolve('approved', 'session')}
        >
          本会话内允许
        </button>
        <button
          className="ghost danger"
          onClick={() => resolve('denied', 'once')}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
