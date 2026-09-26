import { useEffect, useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { listDelegations } from '../../../api/agents'
import { getSessionData, type SessionData } from '../../../api/sessions'

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
  const [children, setChildren] = useState<Delegation[]>([])
  const [error, setError] = useState<string | null>(null)
  const running = ['pending', 'running'].includes(delegation.status)

  useEffect(() => {
    const sessionId = delegation.childSessionId
    if (sessionId === null) return
    let disposed = false
    const refresh = (): void => {
      void Promise.all([getSessionData(sessionId), listDelegations(sessionId)])
        .then(([next, nextChildren]) => {
          if (!disposed) {
            setData(next)
            setChildren(nextChildren)
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
  }, [delegation.childSessionId, running])

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
            <strong>{delegation.agentId}</strong>
            <span>{delegation.task}</span>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="child-trace-body">
          {delegation.childSessionId === null && <p>子会话尚未创建。</p>}
          {error && <p className="delegation-error">{error}</p>}
          {!data && delegation.childSessionId !== null && !error && (
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
            </article>
          ))}
          {children.length > 0 && (
            <section className="child-trace-children">
              <strong>下级委派</strong>
              {children.map((child) => (
                <div key={child.id}>
                  <span>{child.agentId}</span>
                  <span>{child.status}</span>
                  <p>{child.task}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      </section>
    </div>
  )
}
