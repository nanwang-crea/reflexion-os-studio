import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Delegation,
  ResourceLink,
  Usage,
} from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'
import { AssistantMessage } from './AssistantMessage'
import { RunProcess, type ProcessItem } from './RunProcess'
import { ChangedFiles } from './ChangedFiles'
import { DelegationList } from './DelegationList'

interface RunBlockProps {
  processItems: ProcessItem[]
  finalItem: ProcessItem | null
  delegations: Delegation[]
  runActive: boolean
  runActivity?: import('../../hooks/useAppBootstrap').RunActivity
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runDurationMs: number | null
  runUsage: Usage | null
  canRetry: boolean
  onRetry: () => void
  onResourceClick?: (link: ResourceLink) => void
  projectId: string
}

export function RunBlock(props: RunBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(props.runActive)
  const previousActive = useRef<boolean | null>(null)
  const processItems = useMemo(() => {
    if (props.finalItem === null) return props.processItems
    const reasoning =
      props.streamingReasoning[props.finalItem.message.id] ??
      props.finalItem.message.reasoning
    return reasoning !== ''
      ? [
          ...props.processItems,
          {
            ...props.finalItem,
            message: { ...props.finalItem.message, content: '' },
          },
        ]
      : props.processItems
  }, [props.finalItem, props.processItems, props.streamingReasoning])
  // 追加进时间线展示思考的 finalItem 副本：即便流式缓存里还残留完整正文
  // （message.completed 占位、刷新落地前），时间线也只渲染该消息的思考、
  // 不再渲染正文，避免与下方最终回复同时显示“两条一样的消息”。
  const reasoningOnlyIds = useMemo(() => {
    if (props.finalItem === null) return undefined
    const reasoning =
      props.streamingReasoning[props.finalItem.message.id] ??
      props.finalItem.message.reasoning
    return reasoning !== ''
      ? new Set([props.finalItem.message.id])
      : undefined
  }, [props.finalItem, props.streamingReasoning])
  const hasProcess = processItems.length > 0

  useEffect(() => {
    const wasActive = previousActive.current
    previousActive.current = props.runActive
    if (wasActive === null || wasActive !== props.runActive) {
      setOpen(props.runActive)
    }
  }, [props.runActive])

  const label = props.runActive
    ? props.runActivity?.retry !== undefined
      ? `正在重试（第 ${props.runActivity.retry.attempt}/${props.runActivity.retry.maxRetries} 次）…`
      : '正在处理…'
    : props.runDurationMs !== null
      ? `工作了 ${formatDuration(props.runDurationMs)}`
      : '处理完成'

  return (
    <div className="run-block">
      {hasProcess && (
        <div className="run-process">
          <button
            type="button"
            className="run-process-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span
              className={`run-process-label${props.runActive ? ' shimmer' : ''}`}
            >
              {label}
            </span>
            <span className={`run-process-chevron${open ? ' open' : ''}`}>
              <ChevronIcon />
            </span>
          </button>
          {open && (
            <div className="run-process-body">
              <RunProcess
                items={processItems}
                streaming={props.streaming}
                streamingReasoning={props.streamingReasoning}
                runActive={props.runActive}
                reasoningOnlyMessageIds={reasoningOnlyIds}
              />
            </div>
          )}
        </div>
      )}
      {props.finalItem && (
        <AssistantMessage
          message={props.finalItem.message}
          toolCalls={props.finalItem.toolCalls}
          hideReasoning={true}
          runActive={props.runActive}
          runActivity={props.runActivity}
          streamingText={props.streaming[props.finalItem.message.id]}
          streamingReasoning={
            props.streamingReasoning[props.finalItem.message.id]
          }
          runDurationMs={props.runDurationMs}
          runUsage={props.runUsage}
          canRetry={props.canRetry}
          onRetry={props.onRetry}
          onResourceClick={props.onResourceClick}
        />
      )}
      <ChangedFiles
        items={props.processItems}
        finalItem={props.finalItem}
        projectId={props.projectId}
        onResourceClick={props.onResourceClick}
      />
      <DelegationList items={props.delegations} runActive={props.runActive} />
    </div>
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0)
    return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`
  return `${secs} 秒`
}
