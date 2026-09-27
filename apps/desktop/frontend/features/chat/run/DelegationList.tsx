import { useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { cancelDelegation } from '../../../api/agents'
import { ChevronIcon } from '../../../ui/icons'
import { ChildAgentTrace } from './ChildAgentTrace'

interface DelegationListProps {
  items: Delegation[]
  runActive: boolean
}

const STATUS_LABELS: Record<Delegation['status'], string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 父 Run 发起的子 Agent 委派列表：状态徽标 + 任务摘要 + 结果/错误。 */
export function DelegationList({
  items,
  runActive,
}: DelegationListProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [traceId, setTraceId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (items.length === 0) return <></>
  const running = items.some(
    (entry) => entry.status === 'pending' || entry.status === 'running',
  )
  const trace = items.find((item) => item.id === traceId) ?? null

  return (
    <div className="delegation-list">
      <button
        type="button"
        className="delegation-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={`delegation-label${running || runActive ? ' shimmer' : ''}`}
        >
          子 Agent（{items.length}）
        </span>
        <span className={`run-process-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="delegation-body">
          {items.map((delegation) => (
            <div key={delegation.id} className="delegation-row">
              <span
                className={`delegation-status ${delegation.status}`}
                aria-label={`状态：${STATUS_LABELS[delegation.status]}`}
              >
                {STATUS_LABELS[delegation.status]}
              </span>
              <div className="delegation-content">
                <div className="delegation-head">
                  <span className="delegation-agent">
                    {delegation.agentInstance?.name ?? delegation.agentId}
                  </span>
                  <div className="delegation-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        setDetailId((current) =>
                          current === delegation.id ? null : delegation.id,
                        )
                      }
                    >
                      {detailId === delegation.id ? '收起详情' : '详情'}
                    </button>
                    {delegation.childSessionId && (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setTraceId(delegation.id)}
                      >
                        执行轨迹
                      </button>
                    )}
                    {['pending', 'running'].includes(delegation.status) && (
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={cancellingId === delegation.id}
                        onClick={() => {
                          setCancellingId(delegation.id)
                          setActionError(null)
                          void cancelDelegation(delegation.id)
                            .then(({ accepted }) => {
                              if (!accepted)
                                setActionError('子 Agent 已结束或无法取消')
                            })
                            .catch((caught) =>
                              setActionError(
                                caught instanceof Error
                                  ? caught.message
                                  : String(caught),
                              ),
                            )
                            .finally(() => setCancellingId(null))
                        }}
                      >
                        {cancellingId === delegation.id ? '取消中…' : '取消'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="delegation-task">{delegation.task}</div>
                {detailId === delegation.id && delegation.execution && (
                  <dl className="delegation-details">
                    {delegation.agentInstance && (
                      <div>
                        <dt>实例</dt>
                        <dd>
                          {delegation.agentInstance.role}
                          {delegation.agentInstance.templateId
                            ? ` · 模板 ${delegation.agentInstance.templateId}`
                            : ' · 无模板'}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>模型</dt>
                      <dd>{delegation.execution.model}</dd>
                    </div>
                    <div>
                      <dt>权限</dt>
                      <dd>{delegation.execution.permissionPreset}</dd>
                    </div>
                    <div>
                      <dt>深度</dt>
                      <dd>{delegation.execution.depth}</dd>
                    </div>
                    <div>
                      <dt>超时</dt>
                      <dd>{delegation.execution.timeoutSec ?? '默认'} 秒</dd>
                    </div>
                    <div>
                      <dt>输出预算</dt>
                      <dd>
                        {delegation.execution.tokenBudget ?? '默认'} tokens
                      </dd>
                    </div>
                    <div className="delegation-tools">
                      <dt>工具</dt>
                      <dd>{delegation.execution.allowedTools.join('、')}</dd>
                    </div>
                  </dl>
                )}
                {delegation.result && (
                  <div className="delegation-result">{delegation.result}</div>
                )}
                {delegation.structuredResult && (
                  <div className="delegation-result-meta">
                    {delegation.structuredResult.toolCallCount} 次工具调用 ·
                    {delegation.structuredResult.resourceLinks.length} 个资源 ·
                    {delegation.structuredResult.changedFiles.length} 个变更文件
                  </div>
                )}
                {delegation.error && (
                  <div className="delegation-error">{delegation.error}</div>
                )}
              </div>
            </div>
          ))}
          {actionError && (
            <div className="delegation-error" role="alert">
              {actionError}
            </div>
          )}
        </div>
      )}
      {trace && (
        <ChildAgentTrace delegation={trace} onClose={() => setTraceId(null)} />
      )}
    </div>
  )
}
