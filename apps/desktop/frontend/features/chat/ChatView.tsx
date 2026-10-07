import type { ChatViewProps } from './chat-view-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Run,
  ToolCall,
  Delegation,
  RunEvent,
} from '@reflexion-os-studio/runtime-client'
import { Composer } from '../../components/Composer'
import { UserMessage } from './message/UserMessage'
import { ArrowDownIcon, SparkIcon } from '../../ui/icons'
import './approvals/approvals.css'
import { ApprovalQueue } from './approvals/ApprovalQueue'
import { DangerLeaseBanner } from './approvals/DangerLeaseBanner'
import { AssistantMessage } from './message/AssistantMessage'
import { RunBlock } from './run/RunBlock'
import type { DelegationAttention } from './run/DelegationList'
import { QueueBar } from './QueueBar'
import { PlanCard } from './run/PlanCard'
import { RunEventCard } from './run/RunEventCard'
import {
  buildChatBlocks,
  computeRunDurationMs,
  isLastEditableUserMessage,
} from './chat-blocks'
import { InteractionQueue } from './interactions/InteractionQueue'

/** 距底部小于该值视为“贴底”，流式期间继续跟随滚动。 */
const PIN_THRESHOLD_PX = 80

/** Map 未命中时复用同一空数组，避免每帧给子组件新身份。 */
const EMPTY_DELEGATIONS: Delegation[] = []
const EMPTY_FAILED_EVENTS: RunEvent[] = []

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [editMessageId, setEditMessageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const sessionId = props.sessionData?.session?.id ?? null

  const messages = useMemo(
    () => props.sessionData?.messages ?? [],
    [props.sessionData],
  )
  const currentPlan = useMemo(() => {
    const plans = props.sessionData?.plans ?? []
    // 显示策略（翻篇即退场）：active 常驻可见；最近一个 completed 仅作完成回执，
    // 用户发出下一条消息（话题翻篇）后即退场；cancelled 不渲染，避免"幽灵计划"
    // 占着 UI 让用户困惑（Codex 式短命进度板）。
    const recentFirst = [...plans].reverse()
    const active = recentFirst.find((plan) => plan.status === 'active')
    if (active) return active
    const finished = recentFirst.find((plan) => plan.status === 'completed')
    if (!finished || finished.completedAt === null) return finished ?? null
    const completedAt = finished.completedAt
    const hasNewerUserMessage = (props.sessionData?.messages ?? []).some(
      (message) => message.role === 'user' && message.createdAt > completedAt,
    )
    return hasNewerUserMessage ? null : finished
  }, [props.sessionData])
  const runs = useMemo(() => props.sessionData?.runs ?? [], [props.sessionData])
  const visibleRuns = useMemo(
    () => runs.filter((run) => run.supersededByRunId === null),
    [runs],
  )
  const toolCalls = useMemo(
    () => props.sessionData?.toolCalls ?? [],
    [props.sessionData],
  )
  const runIds = useMemo(() => new Set(runs.map((run) => run.id)), [runs])
  // 工具调用按发起消息分组，随助手消息渲染轨迹卡片。
  const toolCallsByMessage = useMemo(() => {
    const groups = new Map<string, ToolCall[]>()
    for (const call of toolCalls) {
      if (call.messageId === null) continue
      const group = groups.get(call.messageId)
      if (group) group.push(call)
      else groups.set(call.messageId, [call])
    }
    return groups
  }, [toolCalls])
  // 当前父会话统一承载根 Run 及其整棵委派树的审批与结构化提问。
  const sessionApprovals = useMemo(
    () =>
      props.pendingApprovals.filter(
        (entry) =>
          runIds.has(entry.runId) ||
          (entry.context?.agent !== undefined &&
            runIds.has(entry.context.agent.rootRunId)),
      ),
    [props.pendingApprovals, runIds],
  )
  const sessionInteractions = useMemo(
    () =>
      props.pendingInteractions.filter(
        (entry) =>
          runIds.has(entry.runId) ||
          (entry.agent !== undefined && runIds.has(entry.agent.rootRunId)),
      ),
    [props.pendingInteractions, runIds],
  )
  const delegationAttention = useMemo(() => {
    const attention = new Map<string, DelegationAttention>()
    for (const entry of sessionApprovals) {
      const instanceId = entry.context?.agent?.instanceId
      if (instanceId !== null && instanceId !== undefined) {
        attention.set(instanceId, 'approval')
      }
    }
    for (const entry of sessionInteractions) {
      const instanceId = entry.agent?.instanceId
      if (instanceId !== null && instanceId !== undefined) {
        attention.set(instanceId, 'input')
      }
    }
    return attention
  }, [sessionApprovals, sessionInteractions])
  const runById = useMemo(() => {
    const map = new Map<string, Run>()
    for (const run of runs) map.set(run.id, run)
    return map
  }, [runs])
  const delegationsByRun = useMemo(() => {
    const map = new Map<string, Delegation[]>()
    for (const entry of props.delegations) {
      const group = map.get(entry.parentRunId)
      if (group) group.push(entry)
      else map.set(entry.parentRunId, [entry])
    }
    return map
  }, [props.delegations])
  const failedEventsByRun = useMemo(() => {
    const map = new Map<string, RunEvent[]>()
    for (const event of props.sessionData?.runEvents ?? []) {
      if (event.type !== 'failed') continue
      const group = map.get(event.runId)
      if (group) group.push(event)
      else map.set(event.runId, [event])
    }
    return map
  }, [props.sessionData])
  const runActive =
    sessionApprovals.length > 0 ||
    sessionInteractions.length > 0 ||
    visibleRuns.some(
      (run) =>
        run.status === 'created' ||
        run.status === 'running' ||
        run.status === 'awaiting_approval' ||
        run.status === 'awaiting_user_input',
    )
  const activeRunIds = useMemo(() => {
    const ids = new Set(
      visibleRuns
        .filter(
          (run) =>
            run.status === 'created' ||
            run.status === 'running' ||
            run.status === 'awaiting_approval' ||
            run.status === 'awaiting_user_input',
        )
        .map((run) => run.id),
    )
    for (const runId of Object.keys(props.runActivities)) {
      const run = visibleRuns.find((candidate) => candidate.id === runId)
      if (
        run === undefined ||
        !['completed', 'failed', 'cancelled', 'interrupted'].includes(
          run.status,
        )
      ) {
        ids.add(runId)
      }
    }
    return ids
  }, [visibleRuns, props.runActivities])
  const chatBlocks = useMemo(
    () => buildChatBlocks(messages, toolCallsByMessage),
    [messages, toolCallsByMessage],
  )
  const lastRetryableRun = useMemo(
    () =>
      [...visibleRuns]
        .reverse()
        .find(
          (run) =>
            run.status === 'failed' ||
            run.status === 'interrupted' ||
            run.status === 'cancelled',
        ),
    [visibleRuns],
  )

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    setPinned(
      el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX,
    )
  }, [])

  // 切换会话时回到贴底状态。
  useEffect(() => {
    setPinned(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId])

  // 流式期间仅在贴底时跟随，用户回看历史时不打断。
  useEffect(() => {
    if (!pinned) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, props.streaming, props.streamingReasoning, pinned])

  const { onRetry } = props
  const handleRetry = useCallback((): void => {
    void onRetry()
  }, [onRetry])

  const startEdit = (messageId: string): void => {
    const message = messages.find((m) => m.id === messageId)
    if (!message || message.role !== 'user') return
    setEditMessageId(messageId)
    setEditDraft(message.content)
  }

  const saveEdit = async (): Promise<void> => {
    if (editMessageId === null || editDraft.trim() === '') return
    try {
      setEditSaving(true)
      await props.onEditResend(editMessageId, editDraft.trim())
      setEditMessageId(null)
      setEditDraft('')
    } catch {
      // 全局 notice 由 useSessionActions 统一展示；保留草稿供用户修正或重试。
    } finally {
      setEditSaving(false)
    }
  }

  const cancelEdit = (): void => {
    setEditMessageId(null)
    setEditDraft('')
  }

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }

  return (
    <div className="chat-view">
      {currentPlan && <PlanCard key={currentPlan.id} plan={currentPlan} />}
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="transcript">
          {messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-icon" aria-hidden="true">
                <SparkIcon size={20} />
              </div>
              发送第一条消息开始对话。输入 / 可选用技能。
            </div>
          )}
          {chatBlocks.map((block) => {
            if (block.kind === 'run') {
              const run = runById.get(block.runId) ?? null
              const finalMessage =
                block.finalItem?.message ??
                block.processItems[block.processItems.length - 1]?.message
              // 重试事件只作内联活状态，不进时间线；失败事件渲染为失败卡。
              const runEvents =
                failedEventsByRun.get(block.runId) ?? EMPTY_FAILED_EVENTS
              const failureDetail = runEvents[0]
              return (
                <div key={block.runId}>
                  {runEvents.map((event) => (
                    <RunEventCard key={event.id} event={event} />
                  ))}
                  <RunBlock
                    processItems={block.processItems}
                    finalItem={block.finalItem}
                    delegations={
                      delegationsByRun.get(block.runId) ?? EMPTY_DELEGATIONS
                    }
                    delegationAttention={delegationAttention}
                    runActive={activeRunIds.has(block.runId)}
                    runActivity={props.runActivities[block.runId]}
                    streaming={props.streaming}
                    streamingReasoning={props.streamingReasoning}
                    runDurationMs={
                      finalMessage
                        ? computeRunDurationMs(run, finalMessage)
                        : null
                    }
                    runUsage={run?.usage ?? null}
                    runFailed={run?.status === 'failed'}
                    failureDetail={failureDetail?.errorMessage ?? null}
                    canRetry={
                      lastRetryableRun !== undefined &&
                      lastRetryableRun.id === block.runId
                    }
                    onRetry={handleRetry}
                    onResourceClick={props.onResourceClick}
                    onOpenDiff={props.onOpenDiff}
                    projectId={props.sessionData?.session?.projectId ?? ''}
                  />
                </div>
              )
            }

            const { message, toolCalls } = block.item

            if (
              message.role === 'assistant' &&
              message.status === 'completed' &&
              message.content === '' &&
              message.reasoning === '' &&
              toolCalls.length === 0
            ) {
              return null
            }
            if (message.role === 'user') {
              const lastUserMsg = isLastEditableUserMessage(
                message,
                messages,
                runActive,
              )
              return (
                <UserMessage
                  key={message.id}
                  message={message}
                  editing={editMessageId === message.id}
                  editable={lastUserMsg}
                  editDraft={editDraft}
                  editSaving={editSaving}
                  onDraftChange={setEditDraft}
                  onCancel={cancelEdit}
                  onSave={saveEdit}
                  onEdit={() => startEdit(message.id)}
                />
              )
            }
            if (message.role === 'assistant') {
              return (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  toolCalls={toolCalls}
                  runActive={activeRunIds.has(message.runId ?? '')}
                  runActivity={
                    message.runId !== null
                      ? props.runActivities[message.runId]
                      : undefined
                  }
                  streamingText={props.streaming[message.id]}
                  streamingReasoning={props.streamingReasoning[message.id]}
                  runDurationMs={null}
                  runUsage={null}
                  canRetry={false}
                  onRetry={handleRetry}
                  onResourceClick={props.onResourceClick}
                />
              )
            }
            return (
              <div key={message.id} className="msg-system">
                {message.content}
              </div>
            )
          })}
        </div>
      </div>

      {!props.hasEnabledProvider && (
        <div className="inline-banner" role="status" aria-live="polite">
          <span>
            尚未配置模型 Provider：请先在设置中填写 API Key 后再开始对话。
          </span>
          <button type="button" className="ghost" onClick={props.onGoSettings}>
            去配置
          </button>
        </div>
      )}

      {sessionId !== null && (
        <QueueBar sessionId={sessionId} agentTemplates={props.agentTemplates} />
      )}

      <div className="composer-wrap">
        {props.sessionData?.session?.executionMode === 'plan' && (
          <div className="plan-mode-banner" role="status">
            <span>计划模式 · 仅允许只读调研，批准计划后才能执行修改</span>
            <button
              type="button"
              className="ghost"
              disabled={runActive}
              title={runActive ? '运行中请通过计划审批退出' : '退出计划模式'}
              onClick={() => void props.onExecutionModeChange('execute')}
            >
              退出
            </button>
          </div>
        )}
        {props.dangerLease !== null && (
          <DangerLeaseBanner
            lease={props.dangerLease}
            onDisable={props.onDisableDanger}
          />
        )}
        <ApprovalQueue
          approvals={sessionApprovals}
          onChoose={props.onResolveApproval}
        />
        <InteractionQueue
          onResourceClick={props.onResourceClick}
          interactions={sessionInteractions}
          onSubmit={props.onInteractionSubmit}
        />
        {!pinned && messages.length > 0 && (
          <button
            className="scroll-bottom"
            aria-label="回到底部"
            title="回到底部"
            onClick={scrollToBottom}
          >
            <ArrowDownIcon />
          </button>
        )}
        <Composer
          placeholder={
            runActive
              ? '正在回复，可继续输入排队发送…'
              : !props.hasEnabledProvider
                ? '请先在设置中配置 API Key…'
                : '输入消息，Enter 发送；/ 使用技能'
          }
          disabled={!props.hasEnabledProvider}
          busy={runActive}
          permissionValue={props.permissionValue}
          onPermissionChange={props.onPermissionChange}
          advanced={props.advanced}
          modelOptions={props.modelOptions}
          selectedModelKey={props.selectedModelKey}
          onModelChange={props.onModelChange}
          skills={props.skills}
          agentTemplates={props.agentTemplates}
          prefill={props.composerPrefill ?? null}
          onSend={props.onSend}
          onStop={props.onStop}
        />
      </div>
    </div>
  )
}
