import { useMemo, useState } from 'react'
import type {
  ChangedFile,
  Delegation,
} from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import type { ChatViewProps } from '../../chat-view-types'
import './task-results.css'

export function TaskResults({
  chat,
  runId,
  items,
  onSelect,
}: {
  chat: ChatViewProps
  runId: string
  items: Delegation[]
  onSelect: (item: Delegation) => void
}): React.JSX.Element {
  const files = useMemo(() => {
    const entries = new Map<
      string,
      {
        path: string
        sources: Map<string, { file: ChangedFile; agent?: Delegation }>
      }
    >()
    const record = (file: ChangedFile, agent?: Delegation) => {
      const key = file.path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
      const entry = entries.get(key) ?? { path: file.path, sources: new Map() }
      entry.sources.set(agent?.id ?? runId, { file, agent })
      entries.set(key, entry)
    }
    for (const call of chat.sessionData?.toolCalls ?? []) {
      if (
        call.runId !== runId ||
        call.status !== 'completed' ||
        call.toolName === 'task'
      )
        continue
      for (const file of call.output?.changedFiles ?? []) record(file)
    }
    for (const item of items) {
      for (const file of item.structuredResult?.changedFiles ?? [])
        record(file, item)
    }
    return [...entries.values()]
  }, [chat.sessionData?.toolCalls, runId, items])
  const projectId = chat.sessionData?.session?.projectId
  const [target, setTarget] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="task-results" aria-label="本次文件变更">
      <h3>
        本次文件变更 <small>{files.length}</small>
      </h3>
      <p>
        打开文件查看当前内容，或查看各 Agent
        记录的修改。变更记录不代表已审查或整合。
      </p>
      {!files.length && (
        <p>还没有记录到文件变更。文字结论与执行过程可在下方查看。</p>
      )}
      {files.map(({ path, sources }) => (
        <article key={path}>
          <strong>{path}</strong>
          <div className="task-result-actions">
            {projectId && chat.onResourceClick && (
              <button
                type="button"
                onClick={() =>
                  chat.onResourceClick?.({
                    kind: 'workspaceFile',
                    projectId,
                    path,
                    uri: workspaceFileUri(projectId, path),
                  })
                }
              >
                打开文件
              </button>
            )}
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                setTarget(path)
                setError(null)
              }}
            >
              针对文件反馈
            </button>
          </div>
          {[...sources.entries()].map(([id, { file, agent }]) => (
            <div className="task-result-source" key={id}>
              <span>
                {agent?.agentInstance?.name ??
                  (agent ? agent.agentId : '主 Agent')}{' '}
                ·{' '}
                {file.action === 'deleted'
                  ? '删除'
                  : file.action === 'moved'
                    ? '移动'
                    : file.action === 'created'
                      ? '新建'
                      : '修改'}
              </span>
              {chat.onOpenDiff && (
                <button
                  type="button"
                  onClick={() =>
                    chat.onOpenDiff?.(file.path, {
                      source: 'chat',
                      before: file.before,
                      after: file.after,
                      oldPath: file.oldPath,
                    })
                  }
                >
                  查看修改
                </button>
              )}
              {agent && (
                <button type="button" onClick={() => onSelect(agent)}>
                  查看来源
                </button>
              )}
            </div>
          ))}
        </article>
      ))}
      {target && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!feedback.trim() || sending) return
            setSending(true)
            setError(null)
            void chat
              .onSend(
                `针对文件 ${JSON.stringify(target)} 的反馈：\n${feedback.trim()}`,
              )
              .then(() => {
                setFeedback('')
                setTarget(null)
              })
              .catch((caught) => setError(String(caught)))
              .finally(() => setSending(false))
          }}
        >
          <label>
            对 {target} 的反馈
            <textarea
              value={feedback}
              disabled={sending}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="描述希望修改或检查的内容…"
              required
            />
          </label>
          <p>发送到当前对话，由主 Agent 处理；回复中会加入发送队列。</p>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={sending || !feedback.trim()}>
            发送给主 Agent
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={() => setTarget(null)}
          >
            取消
          </button>
        </form>
      )}
    </section>
  )
}
