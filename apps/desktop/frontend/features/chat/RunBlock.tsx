import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Delegation,
  ResourceLink,
  Usage,
} from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'
import type { RunActivity } from '../../hooks/useRunActivity'
import { AssistantMessage } from './AssistantMessage'
import { RunProcess, type ProcessItem } from './RunProcess'
import { ChangedFiles } from './ChangedFiles'
import { DelegationList } from './DelegationList'

interface RunBlockProps {
  processItems: ProcessItem[]
  finalItem: ProcessItem | null
  delegations: Delegation[]
  runActive: boolean
  runActivity?: RunActivity
  /** 重试倒计时心跳：有活重试时按节拍自增，驱动回退行与内联倒计时重算剩余秒数。 */
  retryTick: number
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runDurationMs: number | null
  runUsage: Usage | null
  /** Run 最终状态为 failed（非进行中）时用“运行失败”替代“处理完成”。 */
  runFailed: boolean
  /** 该 Run 的失败事件（含错误码与完整错误信息）；无失败或无记录时为 null。 */
  failureDetail?: string | null
  canRetry: boolean
  onRetry: () => void
  onResourceClick?: (link: ResourceLink) => void
  /** 点击已变更文件：有编辑前后快照时展示本次编辑 Diff。 */
  onOpenDiff?: (
    path: string,
    options: {
      source: 'chat'
      before?: string
      after?: string
      oldPath?: string
    },
  ) => void
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
    return reasoning !== '' ? new Set([props.finalItem.message.id]) : undefined
  }, [props.finalItem, props.streamingReasoning])
  const hasProcess = processItems.length > 0

  useEffect(() => {
    const wasActive = previousActive.current
    previousActive.current = props.runActive
    if (wasActive === null || wasActive !== props.runActive) {
      setOpen(props.runActive)
    }
  }, [props.runActive])

  // 活重试的倒计时：由事件携带的退避时长与本地起始时间戳换算剩余秒数。
  // retryTick 只用于触发重算；归零后回落为“正在重试”，等下一次事件覆盖。
  // 倒计时随流内联在 AssistantMessage 正文断点处；顶部标签只表达阶段，
  // 仅在无 finalItem 承载内联指示时（第 2 轮请求建立即重试）由回退行展示。
  const retry = props.runActivity?.retry
  const retryCountdown =
    retry !== undefined &&
    retry.waitMs !== undefined &&
    retry.startedAt !== undefined
      ? Math.max(
          0,
          Math.ceil((retry.waitMs - (Date.now() - retry.startedAt)) / 1000),
        )
      : null
  const retryLabel =
    retry === undefined
      ? null
      : retryCountdown !== null && retryCountdown > 0
        ? `正在重试（第 ${retry.attempt}/${retry.maxRetries} 次）… ${retryCountdown} 秒后自动重试`
        : retryCountdown !== null
          ? '正在重试…'
          : `正在重试（第 ${retry.attempt}/${retry.maxRetries} 次）…`
  const label = props.runActive
    ? '正在处理…'
    : props.runFailed
      ? '运行失败'
      : props.runDurationMs !== null
        ? `工作了 ${formatDuration(props.runDurationMs)}`
        : '处理完成'

  return (
    <div className="run-block">
      {/* 兜底：无 finalItem 承载内联重试指示时（第 2 轮请求建立即重试），
          在块顶部展示重试状态行，保证重试状态始终可见。 */}
      {!props.finalItem && props.runActive && retryLabel !== null && (
        <div className="run-process">
          <span className="run-process-label shimmer">{retryLabel}</span>
        </div>
      )}
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
          retryTick={props.retryTick}
          streamingText={props.streaming[props.finalItem.message.id]}
          streamingReasoning={
            props.streamingReasoning[props.finalItem.message.id]
          }
          runDurationMs={props.runDurationMs}
          runUsage={props.runUsage}
          failureDetail={props.failureDetail}
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
        onOpenDiff={props.onOpenDiff}
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
