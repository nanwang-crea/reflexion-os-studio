import { ChatBlockView } from './transcript/ChatBlockView'
import { VirtualTranscript } from './transcript/VirtualTranscript'
import { HistoryLoader } from './transcript/HistoryLoader'
import { EmptyState } from '../../components/feedback/EmptyState'
import type { ChatViewProps } from './chat-view-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Run,
  ToolCall,
  Delegation,
  RunEvent,
} from '@reflexion-os-studio/runtime-client'
import { Composer } from '../../components/Composer'
import { ArrowDownIcon, SparkIcon } from '../../ui/icons'
import './approvals/approvals.css'
import { ApprovalQueue } from './approvals/ApprovalQueue'
import { DangerLeaseBanner } from './approvals/DangerLeaseBanner'
import type { DelegationAttention } from './run/DelegationList'
import { QueueBar } from './QueueBar'
import { PlanCard } from './run/PlanCard'
import { buildChatBlocks } from './chat-blocks'
import { InteractionQueue } from './interactions/InteractionQueue'

/** 距底部小于该值视为“贴底”，流式期间继续跟随滚动。 */
const PIN_THRESHOLD_PX = 80

/** Map 未命中时复用同一空数组，避免每帧给子组件新身份。 */

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
          {sessionId && props.sessionData?.nextBefore && (
            <HistoryLoader
              key={sessionId}
              sessionId={sessionId}
              before={props.sessionData.nextBefore}
              onLoad={props.onLoadOlder}
              onStart={() => setPinned(false)}
            />
          )}
          {messages.length === 0 && (
            <div className="chat-empty">
              <EmptyState
                icon={<SparkIcon size={20} />}
                title="开始这段对话"
                description="在下方描述你想完成的任务。输入 / 可选择技能；项目对话会使用对应工作区上下文。"
              />
            </div>
          )}
          <VirtualTranscript
            key={sessionId}
            blocks={chatBlocks}
            scrollRef={scrollRef}
            pinned={pinned}
            renderBlock={(block) => (
              <ChatBlockView
                block={block}
                view={props}
                runById={runById}
                failedEventsByRun={failedEventsByRun}
                delegationsByRun={delegationsByRun}
                delegationAttention={delegationAttention}
                activeRunIds={activeRunIds}
                lastRetryableRun={lastRetryableRun}
                runActive={runActive}
                editMessageId={editMessageId}
                editDraft={editDraft}
                editSaving={editSaving}
                onDraftChange={setEditDraft}
                cancelEdit={cancelEdit}
                saveEdit={saveEdit}
                startEdit={startEdit}
                handleRetry={handleRetry}
              />
            )}
          />
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
          reasoningSelection={props.reasoningSelection}
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
