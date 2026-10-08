import { useSyncExternalStore } from 'react'
import {
  acknowledgeOperation,
  checkOperation,
  dismissOperation,
  getOperations,
  subscribeOperations,
} from '../../api/operations'
import type { CoreMutationMethod } from '@reflexion-os-studio/contracts'
import './operations.css'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { ConfirmDialog } from '../ConfirmDialog'

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
  const lastSuccess = operations
    .filter((item) => item.phase === 'succeeded')
    .at(-1)
  const visible = operations.filter(
    (item) => item.phase !== 'succeeded' || item === lastSuccess,
  )
  if (!visible.length) return null
  return (
    <>
      <ConfirmDialog
        state={dialog.confirmState}
        onConfirm={dialog.handleConfirm}
        onCancel={dialog.handleCancel}
      />
      <aside className="operation-host" aria-label="操作状态">
        {visible.map((item) => (
          <section
            key={item.requestId}
            className={`operation-notice operation-${item.phase}`}
            role={
              item.phase === 'failed' || item.phase === 'uncertain'
                ? 'alert'
                : 'status'
            }
          >
            <div className="operation-heading">
              <strong>{labels[item.method]}</strong>
              <span>
                {item.refreshing
                  ? '刷新中'
                  : (
                      {
                        queued: '等待执行',
                        running: '执行中',
                        succeeded: '已完成',
                        failed: '失败',
                        uncertain: '结果未确认',
                      } as const
                    )[item.phase]}
              </span>
            </div>
            {item.error && <p>{item.error}</p>}
            {item.phase === 'succeeded' &&
              item.method.startsWith('message.') && (
                <p>发送请求已完成，回复进度见对话。</p>
              )}
            {item.phase === 'succeeded' && item.unconfirmed && (
              <p>已确认操作完成，请刷新列表或重新加载文件以核对结果。</p>
            )}
            <div className="operation-actions">
              {item.phase === 'uncertain' && (
                <button
                  className="ghost"
                  onClick={() => void checkOperation(item.key)}
                >
                  检查结果
                </button>
              )}
              {item.phase === 'uncertain' && item.canAcknowledge && (
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
              {['succeeded', 'failed'].includes(item.phase) &&
                !item.refreshing && (
                  <button
                    className="ghost"
                    onClick={() => dismissOperation(item.key)}
                  >
                    关闭提示
                  </button>
                )}
            </div>
          </section>
        ))}
      </aside>
    </>
  )
}
