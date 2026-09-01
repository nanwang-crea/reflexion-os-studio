import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Message,
  ResourceLink,
  Run,
  SkillManifest,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from '../../components/Composer'
import { ArrowDownIcon, SparkIcon } from '../../ui/icons'
import { ApprovalCard } from './ApprovalCard'
import { AssistantMessage } from './AssistantMessage'
import { QueueBar } from './QueueBar'
import type { SessionData } from '../../api/sessions'
import type { PendingApproval, RunActivity } from '../../hooks/useAppBootstrap'

interface ChatViewProps {
  sessionData: SessionData | null
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  /** Run 级活动阶段（事件驱动，对齐 Codex）：决定状态行文案与折叠。 */
  runActivities: Record<string, RunActivity>
  hasEnabledProvider: boolean
  permissionValue: string
  onPermissionChange: (value: string) => void
  modelOptions: ComposerModelOption[]
  selectedModelKey: string | null
  onModelChange: (key: string) => void
  skills: SkillManifest[]
  composerPrefill?: { skillId: string; nonce: number } | null
  onPrefillConsumed?: () => void
  onSend: (content: string) => Promise<void>
  onStop: () => Promise<void>
  onRetry: () => Promise<void>
  onGoSettings: () => void
  pendingApprovals: PendingApproval[]
  onResolveApproval: (
    toolCallId: string,
    decision: 'approved' | 'denied',
    scope: 'once' | 'session',
  ) => void
  /** 资源引用（工作区文件/资产/外链）点击后按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
}

/** 距底部小于该值视为“贴底”，流式期间继续跟随滚动。 */
const PIN_THRESHOLD_PX = 80

/** 由 Run 的起止时间合成耗时；找不到 Run 时回退消息自身时间戳。 */
function computeRunDurationMs(runs: Run[], message: Message): number | null {
  const run = runs.find((entry) => entry.id === message.runId) ?? null
  const startedAt = run?.startedAt ?? message.createdAt
  const completedAt = run?.completedAt ?? message.completedAt
  if (startedAt === null || completedAt === null) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return end - start
}

interface DisplayItem {
  message: Message
  toolCalls: ToolCall[]
}

/** 按消息顺序构造 Run 时间线，保留每个模型轮次自身的过程内容。 */
function buildDisplayItems(
  messages: Message[],
  toolCallsByMessage: Map<string, ToolCall[]>,
): DisplayItem[] {
  return messages.map((message) => ({
    message,
    toolCalls: toolCallsByMessage.get(message.id) ?? [],
  }))
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const sessionId = props.sessionData?.session?.id ?? null

  const messages = useMemo(
    () => props.sessionData?.messages ?? [],
    [props.sessionData],
  )
  const runs = useMemo(() => props.sessionData?.runs ?? [], [props.sessionData])
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
  // 审批卡只展示当前会话的等待项（切会话时不串场）。
  const sessionApprovals = props.pendingApprovals.filter((entry) =>
    runIds.has(entry.runId),
  )
  const runActive =
    sessionApprovals.length > 0 ||
    runs.some(
      (run) =>
        run.status === 'created' ||
        run.status === 'running' ||
        run.status === 'awaiting_approval',
    )
  const activeRunIds = useMemo(() => {
    const ids = new Set(
      runs
        .filter(
          (run) =>
            run.status === 'created' ||
            run.status === 'running' ||
            run.status === 'awaiting_approval',
        )
        .map((run) => run.id),
    )
    for (const runId of Object.keys(props.runActivities)) ids.add(runId)
    return ids
  }, [runs, props.runActivities])
  // 按消息创建顺序展示每个模型轮次，工具调用归属发起它的消息。
  const displayItems = useMemo(
    () => buildDisplayItems(messages, toolCallsByMessage),
    [messages, toolCallsByMessage],
  )
  const lastRetryableRun = [...runs]
    .reverse()
    .find(
      (run) =>
        run.status === 'failed' ||
        run.status === 'interrupted' ||
        run.status === 'cancelled',
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

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }

  return (
    <div className="chat-view">
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
          {displayItems.map((item) => {
            const message = item.message
            // 既无正文/思考也无工具调用的占位消息不渲染。
            if (
              message.role === 'assistant' &&
              message.status === 'completed' &&
              message.content === '' &&
              message.reasoning === '' &&
              item.toolCalls.length === 0
            ) {
              return null
            }
            if (message.role === 'user') {
              return (
                <div key={message.id} className="msg-user">
                  <div className="user-bubble">{message.content}</div>
                </div>
              )
            }
            if (message.role === 'assistant') {
              return (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  toolCalls={item.toolCalls}
                  runActive={
                    message.runId !== null && activeRunIds.has(message.runId)
                  }
                  runActivity={
                    message.runId !== null
                      ? props.runActivities[message.runId]
                      : undefined
                  }
                  streamingText={props.streaming[message.id]}
                  streamingReasoning={props.streamingReasoning[message.id]}
                  runDurationMs={computeRunDurationMs(runs, message)}
                  runUsage={
                    runs.find((entry) => entry.id === message.runId)?.usage ??
                    null
                  }
                  canRetry={
                    lastRetryableRun !== undefined &&
                    lastRetryableRun.id === message.runId
                  }
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
        {sessionApprovals.map((approval) => (
          <ApprovalCard
            key={approval.toolCallId}
            approval={approval}
            onResolve={props.onResolveApproval}
          />
        ))}
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
          modelOptions={props.modelOptions}
          selectedModelKey={props.selectedModelKey}
          onModelChange={props.onModelChange}
          skills={props.skills}
          prefill={props.composerPrefill ?? null}
          onSend={props.onSend}
          onStop={props.onStop}
        />
      </div>
    </div>
  )
}
