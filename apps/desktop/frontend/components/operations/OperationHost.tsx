import { useEffect, useSyncExternalStore } from 'react'
import {
  acknowledgeOperation,
  checkOperation,
  getOperations,
  subscribeOperations,
  subscribeOperationCompletions,
} from '../../api/operations'
import type { CoreMutationMethod } from '@reflexion-os-studio/contracts'
import './operations.css'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { ConfirmDialog } from '../ConfirmDialog'
import { showToast } from '../Toast'

const completionToasts = new Set<CoreMutationMethod>([
  'workspace.git_commit',
  'workspace.git_fetch',
  'workspace.git_push',
  'workspace.git_pull',
])

const labels: Record<CoreMutationMethod, string> = {
  'project.create': '创建项目',
  'session.create': '创建会话',
  'provider.configure': '保存模型配置',
  'message.send': '发送消息',
  'message.edit_resend': '编辑重发',
  'run.retry': '重新回复',
  'workspace.write_file': '保存文件',
  'workspace.git_stage': '暂存',
  'workspace.git_unstage': '取消暂存',
  'workspace.git_commit': '提交',
  'workspace.git_fetch': '获取远端更新',
  'workspace.git_push': '推送',
  'workspace.git_pull': '更新',
  'workspace.git_branch_create': '创建分支',
  'workspace.git_branch_switch': '切换分支',
  'workspace.git_remote_add': '添加远端',
  'workspace.git_remote_remove': '删除远端',
}
export function OperationHost(): React.JSX.Element | null {
  const dialog = useConfirmDialog()
  const operations = useSyncExternalStore(subscribeOperations, getOperations)
  useEffect(() => {
    return subscribeOperationCompletions((item, prior) => {
      if (item.phase === 'succeeded' && completionToasts.has(item.method)) {
        showToast(`${labels[item.method]}完成`)
      }
      if (prior?.phase === 'uncertain' && item.phase === 'failed') {
        showToast(
          `${labels[item.method]}失败：${item.error ?? '请核对结果'}`,
          'error',
        )
      }
    })
  }, [])
  const visible = operations.filter((item) => item.phase === 'uncertain')
  if (!visible.length) return null
  return (
    <>
      <ConfirmDialog
        state={dialog.confirmState}
        onConfirm={dialog.handleConfirm}
        onCancel={dialog.handleCancel}
      />
      <aside className="operation-host" aria-label="待确认的操作">
        {visible.map((item) => (
          <section
            key={item.requestId}
            className="toast operation-notice operation-uncertain"
            role="alert"
          >
            <div className="operation-heading">
              <strong>{labels[item.method]}</strong>
              <span>结果未确认</span>
            </div>
            {item.error && <p>{item.error}</p>}
            <div className="operation-actions">
              <button
                className="ghost"
                onClick={() => void checkOperation(item.key)}
              >
                检查结果
              </button>
              {item.canAcknowledge && (
                <button
                  className="ghost"
                  onClick={() =>
                    void dialog
                      .confirm({
                        title: '已核对实际结果？',
                        message:
                          '请先核对文件内容、Git 历史或对话，确认操作已结束。解除保护不会重新执行原操作。',
                        confirmLabel: '已核对，解除保护',
                        danger: false,
                      })
                      .then((confirmed) => {
                        if (confirmed) acknowledgeOperation(item.key)
                      })
                  }
                >
                  核对后解除保护
                </button>
              )}
            </div>
          </section>
        ))}
      </aside>
    </>
  )
}
