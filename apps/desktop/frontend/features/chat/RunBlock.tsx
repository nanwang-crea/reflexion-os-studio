import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResourceLink, Usage } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'
import { AssistantMessage } from './AssistantMessage'
import { RunProcess, type ProcessItem } from './RunProcess'

interface RunBlockProps {
  processItems: ProcessItem[]
  finalItem: ProcessItem | null
  runActive: boolean
  runActivity?: import('../../hooks/useAppBootstrap').RunActivity
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runDurationMs: number | null
  runUsage: Usage | null
  canRetry: boolean
  onRetry: () => void
  onResourceClick?: (link: ResourceLink) => void
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
