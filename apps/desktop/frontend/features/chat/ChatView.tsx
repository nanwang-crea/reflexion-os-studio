import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ResourceLink,
  Run,
  SkillManifest,
  ToolCall,
  Delegation,
  AgentTemplate,
  RunEvent,
} from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from '../../components/Composer'
import { CopyButton } from '../../components/CopyButton'
import { ArrowDownIcon, SparkIcon, PencilIcon } from '../../ui/icons'
import './approvals/approvals.css'
import { ApprovalQueue } from './approvals/ApprovalQueue'
import { DangerLeaseBanner } from './approvals/DangerLeaseBanner'
import { AssistantMessage } from './message/AssistantMessage'
import { RunBlock } from './run/RunBlock'
import { QueueBar } from './QueueBar'
import { PlanCard } from './run/PlanCard'
import { RunEventCard } from './run/RunEventCard'
import type { SessionData } from '../../api/sessions'
import type { PendingApproval } from '../../hooks/useAppBootstrap'
import type { PendingInteraction } from '../../hooks/useAppBootstrap'
import type { RunActivity } from '../../hooks/session/useRunActivity'
import type {
  PermissionPreset,
  DangerAccessLease,
} from '@reflexion-os-studio/runtime-client'
import type { ComposerAdvancedState } from '../../components/Composer'
import {
  buildChatBlocks,
  computeRunDurationMs,
  isLastEditableUserMessage,
} from './chat-blocks'
import { InteractionQueue } from './interactions/InteractionQueue'
import type { UserQuestionAnswer } from '@reflexion-os-studio/runtime-client'

interface ChatViewProps {
  sessionData: SessionData | null
  delegations: Delegation[]
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  /** Run 级活动阶段（事件驱动，对齐 Codex）：决定状态行文案与折叠。 */
  runActivities: Record<string, RunActivity>
  hasEnabledProvider: boolean
  permissionValue: PermissionPreset
  onPermissionChange: (value: PermissionPreset) => void
  advanced: ComposerAdvancedState
  /** Danger 租约（Runtime 真源投影）：激活时 Composer 上方常驻红色状态条。 */
  dangerLease: DangerAccessLease | null
  onDisableDanger: () => void
  modelOptions: ComposerModelOption[]
  selectedModelKey: string | null
  onModelChange: (key: string) => void
  skills: SkillManifest[]
  agentTemplates: AgentTemplate[]
  composerPrefill?: { skillId: string; nonce: number } | null
  onPrefillConsumed?: () => void
  onSend: (content: string, agentTemplateId?: string) => Promise<void>
  onStop: () => Promise<void>
  onRetry: () => Promise<void>
  onGoSettings: () => void
  onExecutionModeChange: (mode: 'execute' | 'plan') => Promise<void>
  pendingApprovals: PendingApproval[]
  onResolveApproval: (toolCallId: string, choiceId: string) => void
  pendingInteractions: PendingInteraction[]
  onInteractionSubmit: (
    interactionId: string,
    answers: UserQuestionAnswer[],
  ) => Promise<boolean>
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
  /** 编辑最后一条用户消息的回调：提交后由 Runtime 处理 superseded 与新 Run 创建。 */
  onEditResend: (messageId: string, content: string) => Promise<void>
  /** 资源引用（工作区文件/资产/外链）点击后按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
}

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
                <div key={message.id} className="msg-user">
                  <div
                    className={`user-bubble${editMessageId === message.id ? ' user-bubble-editing' : ''}`}
                  >
                    {editMessageId === message.id ? (
                      <div className="edit-resend-inline">
                        <textarea
                          className="edit-resend-textarea"
                          rows={4}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') cancelEdit()
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault()
                              void saveEdit()
                            }
                          }}
                          disabled={editSaving}
                          autoFocus
                        />
                        <div className="edit-resend-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={cancelEdit}
                            disabled={editSaving}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void saveEdit()}
                            disabled={editSaving || editDraft.trim() === ''}
                          >
                            {editSaving ? '发送中…' : '发送'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="user-content">{message.content}</div>
                    )}
                  </div>
                  {editMessageId !== message.id && (
                    <div className="user-actions">
                      <CopyButton text={message.content} />
                      {lastUserMsg && (
                        <button
                          type="button"
                          className="msg-action"
                          title="编辑并重发"
                          aria-label="编辑并重发"
                          onClick={() => startEdit(message.id)}
                        >
                          <PencilIcon />
                        </button>
                      )}
                    </div>
                  )}
                </div>
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

      {sessionId !== null && <QueueBar sessionId={sessionId} />}

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
