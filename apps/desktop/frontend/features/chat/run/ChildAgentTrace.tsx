import { useEffect, useState } from 'react'
import type {
  Delegation,
  MutationReceipt,
} from '@reflexion-os-studio/runtime-client'
import { getDelegationTree, listMutationReceipts } from '../../../api/agents'
import { getSessionData, type SessionData } from '../../../api/sessions'
import { DelegationTree } from './DelegationTree'

interface ChildAgentTraceProps {
  delegation: Delegation
  onClose: () => void
}

/** 子 Session 只读轨迹：复用 session.get，不把隐藏子会话塞进主侧栏导航。 */
export function ChildAgentTrace({
  delegation,
  onClose,
}: ChildAgentTraceProps): React.JSX.Element {
  const [data, setData] = useState<SessionData | null>(null)
  const [selected, setSelected] = useState(delegation)
  const [tree, setTree] = useState<Delegation[]>([])
  const [receipts, setReceipts] = useState<MutationReceipt[]>([])
  const [error, setError] = useState<string | null>(null)
  const running = tree.some((item) =>
    ['pending', 'running'].includes(item.status),
  )
  const rootRunId = delegation.rootRunId ?? delegation.parentRunId

  useEffect(() => setSelected(delegation), [delegation])

  useEffect(() => {
    const sessionId = selected.childSessionId
    if (sessionId === null) return
    let disposed = false
    const refresh = (): void => {
      void Promise.all([
        getSessionData(sessionId),
        getDelegationTree(rootRunId),
        listMutationReceipts(rootRunId),
      ])
        .then(([next, nextTree, nextReceipts]) => {
          if (!disposed) {
            setData(next)
            setTree(nextTree)
            setReceipts(nextReceipts)
            setError(null)
          }
        })
        .catch((caught) => {
          if (!disposed)
            setError(caught instanceof Error ? caught.message : String(caught))
        })
    }
    refresh()
    const timer = running ? window.setInterval(refresh, 1000) : undefined
    return () => {
      disposed = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [rootRunId, running, selected.childSessionId])

  return (
    <div className="child-trace-backdrop" role="presentation" onClick={onClose}>
      <section
        className="child-trace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="子 Agent 执行轨迹"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="child-trace-head">
          <div>
            <strong>{selected.agentId}</strong>
            <span>{selected.task}</span>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="child-trace-body">
          <DelegationTree
            items={tree.length > 0 ? tree : [delegation]}
            rootRunId={rootRunId}
            selectedId={selected.id}
            onSelect={(item) => {
              setData(null)
              setSelected(item)
            }}
          />
          {selected.childSessionId === null && <p>子会话尚未创建。</p>}
          {error && <p className="delegation-error">{error}</p>}
          {!data && selected.childSessionId !== null && !error && (
            <p>加载轨迹…</p>
          )}
          {data?.runs.map((run) => (
            <article className="child-trace-run" key={run.id}>
              <div className="child-trace-run-head">
                <span>{run.model ?? '未指定模型'}</span>
                <span>{run.status}</span>
              </div>
              {data.messages
                .filter((message) => message.runId === run.id)
                .map((message) => (
                  <div className="child-trace-message" key={message.id}>
                    <span>{message.role}</span>
                    <pre>{message.content || '（无正文）'}</pre>
                  </div>
                ))}
              {data.toolCalls
                .filter((call) => call.runId === run.id)
                .map((call) => (
                  <div className="child-trace-tool" key={call.id}>
                    <span>{call.toolName}</span>
                    <span>{call.status}</span>
                    {call.output?.content && <pre>{call.output.content}</pre>}
                  </div>
                ))}
              {receipts
                .filter((receipt) => receipt.runId === run.id)
                .map((receipt) => (
                  <div className="child-trace-tool" key={receipt.id}>
                    <span>变更归属 · {receipt.toolName}</span>
                    <span>
                      {receipt.changedFiles
                        .map((file) => `${file.action}: ${file.path}`)
                        .join('、')}
                    </span>
                  </div>
                ))}
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
