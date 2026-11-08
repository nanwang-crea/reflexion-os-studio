import { RunPerformanceDetails } from './RunPerformanceDetails'
import { RunActivityStatus } from './RunActivityStatus'
import { useMemo, useState } from 'react'
import type {
  Delegation,
  ResourceLink,
  Usage,
  RunPerformance,
  Run,
} from '@reflexion-os-studio/runtime-client'
import type { RunActivity } from '../../../hooks/session/useRunActivity'
import { AssistantMessage } from '../message/AssistantMessage'
import { RunProcess, type ProcessItem } from './RunProcess'
import { toolLabel } from '../tools/labels'
import { summarizeToolArgs } from '../tools/summaries'
import { RunRunningStatus } from './RunClock'
import {
  toggleRunDisplayMode,
  useRunDisplayMode,
} from '../../../hooks/ui/runDisplayMode'
import { ChangedFiles, aggregateChangedFiles } from './ChangedFiles'
import { DelegationList, type DelegationAttention } from './DelegationList'

interface RunBlockProps {
  processItems: ProcessItem[]
  finalItem: ProcessItem | null
  delegations: Delegation[]
  delegationAttention?: ReadonlyMap<string, DelegationAttention>
  runActive: boolean
  runActivity?: RunActivity
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runDurationMs: number | null
  runUsage: Usage | null
  runPerformance?: RunPerformance | null
  runStatus?: Run['status']
  /** Run 开始时间（ISO）：紧凑视图的“用时”从这一刻起算。 */
  runStartedAt?: string | null
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
  const changedFiles = useMemo(
    () => aggregateChangedFiles(props.processItems, props.finalItem),
    [props.processItems, props.finalItem],
  )
  // 用户操作后保留展开偏好；仅未操作的过程跟随运行状态自动展开/收起。
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  // 进入作答阶段后默认收起过程正文：否则长过程会把正在流式的最终回答
  // 推出视口，看起来像“回答完才出现”。用户手动展开仍优先。
  const answering = props.runActivity?.phase === 'answering'
  const open = openOverride ?? (props.runActive && !answering)
  const calls = useMemo(
    () => [
      ...props.processItems.flatMap((item) => item.toolCalls),
      ...(props.finalItem?.toolCalls ?? []),
    ],
    [props.processItems, props.finalItem],
  )
  const processItems = useMemo(() => {
    if (props.finalItem === null) return props.processItems
    const reasoning =
      props.streamingReasoning?.[props.finalItem.message.id] ??
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
      props.streamingReasoning?.[props.finalItem.message.id] ??
      props.finalItem.message.reasoning
    return reasoning !== '' ? new Set([props.finalItem.message.id]) : undefined
  }, [props.finalItem, props.streamingReasoning])
  const hasProcess = processItems.length > 0
  const displayMode = useRunDisplayMode()
  const compact = displayMode === 'standard'
  // 标准视图：活动行实时显示“正在分析请求 · <思考最近段落>”，
  // 详细视图保持原有的逐条过程时间线。
  const runningCall = calls.find((call) => call.status === 'running')
  // 标准视图的活动详情（参考 DSH runningDetail）：正在跑工具时显示工具摘要，
  // 否则显示思考的最近段落——这就是截图里“正在分析请求 · 第二段…”的那一段。
  const toolDetail =
    runningCall === undefined
      ? ''
      : [toolLabel(runningCall), summarizeToolArgs(runningCall)]
          .filter((part) => part !== '')
          .join(' · ')
  // 详情只在“思考/工具”阶段显示：作答阶段的正文自己会流式出现，
  // 完成后的状态行变成“已完成，用时 X”，都不应残留最后一段思考。
  const showLiveDetail =
    compact && props.runActive && props.runActivity?.phase !== 'answering'
  const detail = showLiveDetail
    ? toolDetail !== ''
      ? toolDetail
      : latestReasoningDetail(
          [
            ...processItems,
            ...(props.finalItem !== null ? [props.finalItem] : []),
          ],
          props.streamingReasoning,
        )
    : ''
  const runStartedMs =
    props.runStartedAt !== null && props.runStartedAt !== undefined
      ? Date.parse(props.runStartedAt)
      : Number.NaN
  const startedAtMs = Number.isNaN(runStartedMs) ? null : runStartedMs

  return (
    <div className="run-block">
      {(hasProcess || props.runActive) && (
        <div
          className={`run-process${compact && props.runActive ? ' standard-live' : ''}`}
        >
          <RunActivityStatus
            active={props.runActive}
            status={props.runStatus}
            activity={props.runActivity}
            calls={calls}
            delegations={props.delegations}
            attention={props.delegationAttention}
            durationMs={props.runDurationMs}
            hasProcess={hasProcess}
            collapsible={hasProcess && !compact}
            open={open}
            onToggle={() => setOpenOverride(!open)}
            detail={detail === '' ? undefined : detail}
            mode={displayMode}
            onToggleMode={toggleRunDisplayMode}
          />
          {compact && props.runActive && (
            <div className="run-status-row run-clock-row">
              <RunRunningStatus startedAtMs={startedAtMs} />
            </div>
          )}
          {!compact && hasProcess && open && (
            <div
              className="run-process-body"
              onClickCapture={() => setOpenOverride(true)}
              onFocusCapture={() => setOpenOverride(true)}
            >
              <RunProcess
                items={processItems}
                streaming={props.streaming}
                streamingReasoning={props.streamingReasoning}
                runActive={props.runActive}
                reasoningOnlyMessageIds={reasoningOnlyIds}
                onResourceClick={props.onResourceClick}
              />
            </div>
          )}
        </div>
      )}
      <DelegationList
        items={props.delegations}
        runActive={props.runActive}
        attentionByAgentId={props.delegationAttention}
      />
      {props.finalItem && (
        <AssistantMessage
          message={props.finalItem.message}
          toolCalls={props.finalItem.toolCalls}
          hideReasoning={true}
          hideActivity={true}
          runActive={props.runActive}
          runActivity={props.runActivity}
          streamingText={props.streaming?.[props.finalItem.message.id]}
          streamingReasoning={
            props.streamingReasoning?.[props.finalItem.message.id]
          }
          runDurationMs={props.runDurationMs}
          runUsage={props.runUsage}
          failureDetail={props.failureDetail}
          canRetry={props.canRetry}
          onRetry={props.onRetry}
          onResourceClick={props.onResourceClick}
        />
      )}
      {!props.runActive && (
        <RunPerformanceDetails metrics={props.runPerformance} />
      )}
      <ChangedFiles
        files={changedFiles}
        projectId={props.projectId}
        onResourceClick={props.onResourceClick}
        onOpenDiff={props.onOpenDiff}
      />
    </div>
  )
}

/**
 * 标准视图活动详情（参考 DSH liveReasoningDetail）：取最后一条仍在流式的
 * 思考，按其最后一个非空段落压平后前截断；这就是截图里“·”之后实时推进
 * 的那段文字。
 */
function latestReasoningDetail(
  items: ProcessItem[],
  streamingReasoning: Record<string, string> | undefined,
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index].message
    const text = streamingReasoning?.[message.id] ?? message.reasoning ?? ''
    if (text === '') continue
    const paragraphs = text.split(/\r?\n[\t ]*\r?\n/)
    for (let p = paragraphs.length - 1; p >= 0; p -= 1) {
      const detail = paragraphs[p]
        .replaceAll('**', '')
        .replace(/\s+/g, ' ')
        .trim()
      if (detail !== '') return truncateLiveDetail(detail)
    }
  }
  return ''
}

const LIVE_DETAIL_MAX = 120

function truncateLiveDetail(text: string): string {
  return text.length > LIVE_DETAIL_MAX
    ? `${text.slice(0, LIVE_DETAIL_MAX)}…`
    : text
}
