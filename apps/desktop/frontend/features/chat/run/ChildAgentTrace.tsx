import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { getDelegationTree } from '../../../api/agents'
import { getSessionData, type SessionData } from '../../../api/sessions'
import { buildChatBlocks, computeRunDurationMs } from '../chat-blocks'
import { DelegationTree } from './DelegationTree'
import { HistoryLoader } from '../transcript/HistoryLoader'
import { VirtualTranscript } from '../transcript/VirtualTranscript'
import {
  mergeLatestHistory,
  prependHistory,
} from '../../../hooks/session/history-pages'
import type { HistoryCursor } from '@reflexion-os-studio/runtime-client'
import { ReadOnlyDialog } from '../../../components/dialogs/ReadOnlyDialog'
import { RunBlock } from './RunBlock'

interface ChildAgentTraceProps {
  delegation: Delegation
  onClose: () => void
}

/** 子 Session 只读轨迹：复用 session.get，不把隐藏子会话塞进主侧栏导航。 */
export function ChildAgentTrace({
  delegation,
  onClose,
}: ChildAgentTraceProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<SessionData | null>(null)
  const [selected, setSelected] = useState(delegation)
  const [tree, setTree] = useState<Delegation[]>([])
  const [error, setError] = useState<string | null>(null)
  const running = tree.some((item) =>
    ['pending', 'running'].includes(item.status),
  )
  const rootRunId = delegation.rootRunId ?? delegation.parentRunId
  const selectedStatus =
    selected.status === 'pending'
      ? '等待中'
      : selected.status === 'running'
        ? '执行中'
        : selected.status === 'completed'
          ? '已完成'
          : selected.status === 'failed'
            ? '失败'
            : '已取消'

  useEffect(() => setSelected(delegation), [delegation])

  useEffect(() => {
    const sessionId = selected.childSessionId
    if (sessionId === null) return
    let disposed = false
    let requestId = 0
    setData((current) => (current?.session?.id === sessionId ? current : null))
    const refresh = (): void => {
      const request = ++requestId
      void Promise.all([
        getSessionData(sessionId),
        getDelegationTree(rootRunId),
      ])
        .then(([next, nextTree]) => {
          if (!disposed && request === requestId) {
            setData((current) => mergeLatestHistory(current, next))
            setTree(nextTree)
            setSelected(
              (current) =>
                nextTree.find((item) => item.id === current.id) ?? current,
            )
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

  const loadOlder = useCallback(
    async (sessionId: string, before: HistoryCursor): Promise<void> => {
      const older = await getSessionData(sessionId, before)
      setData((current) => {
        if (
          current?.session?.id !== sessionId ||
          current.nextBefore?.rowId !== before.rowId
        )
          return current
        return prependHistory(current, older)
      })
    },
    [],
  )

  const activeRunIds = useMemo(
    () =>
      new Set(
        (data?.runs ?? [])
          .filter((run) =>
            [
              'created',
              'running',
              'awaiting_approval',
              'awaiting_user_input',
            ].includes(run.status),
          )
          .map((run) => run.id),
      ),
    [data],
  )
  const runById = useMemo(
    () => new Map((data?.runs ?? []).map((run) => [run.id, run])),
    [data],
  )
  const chatBlocks = useMemo(() => {
    if (data === null) return []
    const callsByMessage = new Map<string, SessionData['toolCalls']>()
    for (const call of data.toolCalls) {
      if (call.messageId === null) continue
      const calls = callsByMessage.get(call.messageId)
      if (calls) calls.push(call)
      else callsByMessage.set(call.messageId, [call])
    }
    return buildChatBlocks(data.messages, callsByMessage)
  }, [data])
  const streaming = useMemo(() => {
    if (activeRunIds.size === 0 || data === null) return {}
    return Object.fromEntries(
      data.messages
        .filter(
          (message) =>
            message.role === 'assistant' &&
            message.runId !== null &&
            activeRunIds.has(message.runId) &&
            message.content !== '',
        )
        .map((message) => [message.id, message.content]),
    )
  }, [activeRunIds, data])
  const streamingReasoning = useMemo(() => {
    if (activeRunIds.size === 0 || data === null) return {}
    return Object.fromEntries(
      data.messages
        .filter(
          (message) =>
            message.role === 'assistant' &&
            message.runId !== null &&
            activeRunIds.has(message.runId) &&
            message.reasoning !== '',
        )
        .map((message) => [message.id, message.reasoning]),
    )
  }, [activeRunIds, data])

  return (
    <ReadOnlyDialog
      drawer
      label="子 Agent 执行轨迹"
      onClose={onClose}
      title={
        <div>
          <strong>{selected.agentInstance?.name ?? selected.agentId}</strong>
          <span className={`delegation-status ${selected.status}`}>
            {selectedStatus}
          </span>
          <div>{selected.task}</div>
        </div>
      }
    >
      <div className="child-trace-body" ref={scrollRef}>
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
        <div className="child-trace-stream">
          {data?.session && data.nextBefore && (
            <HistoryLoader
              key={data.session.id}
              sessionId={data.session.id}
              before={data.nextBefore}
              onLoad={loadOlder}
            />
          )}
          <VirtualTranscript
            key={selected.childSessionId}
            blocks={chatBlocks}
            scrollRef={scrollRef}
            pinned={false}
            renderBlock={(block) => {
              if (block.kind !== 'run') return null
              const run = runById.get(block.runId) ?? null
              const finalMessage =
                block.finalItem?.message ??
                block.processItems[block.processItems.length - 1]?.message
              return (
                <RunBlock
                  key={block.runId}
                  processItems={block.processItems}
                  finalItem={block.finalItem}
                  delegations={[]}
                  runActive={activeRunIds.has(block.runId)}
                  streaming={streaming}
                  streamingReasoning={streamingReasoning}
                  runDurationMs={
                    finalMessage
                      ? computeRunDurationMs(run, finalMessage)
                      : null
                  }
                  runUsage={run?.usage ?? null}
                  runFailed={run?.status === 'failed'}
                  canRetry={false}
                  onRetry={() => undefined}
                  projectId={data?.session?.projectId ?? ''}
                />
              )
            }}
          />
        </div>
      </div>
    </ReadOnlyDialog>
  )
}
