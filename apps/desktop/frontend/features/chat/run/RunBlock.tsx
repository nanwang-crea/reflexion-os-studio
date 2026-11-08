import { RunPerformanceDetails } from './RunPerformanceDetails'
import { RunActivityStatus, RunModeToggle } from './RunActivityStatus'
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
import { ReasoningBlock } from '../message/ReasoningBlock'
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
  // 标准视图：主状态行只带当前工具/动作摘要，思考另起一行；
  // 详细视图保持原有的逐条过程时间线。
  const runningCall = calls.find((call) => call.status === 'running')
  const detailCall = runningCall ?? [...calls].reverse()[0]
  const detail =
    compact && detailCall !== undefined
      ? [toolLabel(detailCall), summarizeToolArgs(detailCall)]
          .filter((part) => part !== '')
          .join(' · ')
      : ''
  const compactReasoning = useMemo(() => {
    if (!compact) return null
    const items = [
      ...processItems,
      ...(props.finalItem !== null ? [props.finalItem] : []),
    ]
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      const text =
        props.streamingReasoning?.[item.message.id] ?? item.message.reasoning
      if (text === '') continue
      return {
        id: item.message.id,
        text,
        active:
          props.runActive &&
          props.streamingReasoning?.[item.message.id] !== undefined,
      }
    }
    return null
  }, [
    compact,
    processItems,
    props.finalItem,
    props.streamingReasoning,
    props.runActive,
  ])
  const runStartedMs =
    props.runStartedAt !== null && props.runStartedAt !== undefined
      ? Date.parse(props.runStartedAt)
      : Number.NaN
  const startedAtMs = Number.isNaN(runStartedMs) ? null : runStartedMs

  // 标准视图下，运行中只保留“思考行 + 运行时钟”两行（与 DSH 一致）；
  // 需要用户动作或等待重试时，状态行必须出现，否则会丢掉可操作的提示。
  const needsStatusRow =
    !compact ||
    !props.runActive ||
    props.runActivity?.retry !== undefined ||
    props.runStatus === 'awaiting_approval' ||
    props.runStatus === 'awaiting_user_input' ||
    props.delegations.some(
      (item) => item.status === 'pending' || item.status === 'running',
    )

  return (
    <div className="run-block">
      {(hasProcess || props.runActive) && (
        <div className="run-process">
          {needsStatusRow && (
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
          )}
          {compact && compactReasoning !== null && (
            <ReasoningBlock
              compact
              text={compactReasoning.text}
              active={compactReasoning.active}
            />
          )}
          {compact && props.runActive && (
            <div className="run-status-row run-clock-row">
              <RunRunningStatus startedAtMs={startedAtMs} />
              <RunModeToggle
                mode={displayMode}
                onToggle={toggleRunDisplayMode}
              />
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
