import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Message,
  Run,
  SkillManifest,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from '../../components/Composer'
import { ArrowDownIcon, SparkIcon } from '../../ui/icons'
import { ApprovalCard } from './ApprovalCard'
import { AssistantMessage } from './AssistantMessage'
import type { SessionData } from '../../api/sessions'
import type { PendingApproval } from '../../hooks/useAppBootstrap'

interface ChatViewProps {
  sessionData: SessionData | null
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
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

/**
 * 组装展示单元：一个 Run 只产出一条最终回答单元，其余模型轮次（工具调用
 * 轮、中途文本）吸附到它上面——最终回答消息上的 WorkSummary 聚合全部
 * 工具明细与思考，中间轮次的模型文本不展示为正文（与 ChatGPT 桌面版一致：
 * 工具执行过程中的 content 属于过程，不当作消息展示）。
 *
 * 最终回答按 Run 判定：优先取 run 内最后一条无工具调用的消息（纯文本轮）；
 * run 进行中且全为工具轮（final 未出现）时聚合为实时过程单元；终态 run
 * 全工具（如 max_turns 失败）降级取最后一条。
 */
function buildDisplayItems(
  messages: Message[],
  toolCallsByMessage: Map<string, ToolCall[]>,
  activeRunIds: Set<string>,
): DisplayItem[] {
  // 预扫描：每个 run 的最终回答在 messages 中的下标。最终回答 = run 内
  // 最后一条无工具调用的消息（纯文本轮）；进行中且全为工具轮时无最终回答，
  // 终态 run 全工具（如 max_turns 失败）降级取最后一条。
  const finalIndexByRun = new Map<string, number>()
  {
    const lastIndexByRun = new Map<string, number>()
    messages.forEach((message, index) => {
      if (message.role !== 'assistant' || message.runId === null) return
      // 覆盖式记录：遍历结束后即为该 run 的最后一条 assistant 消息。
      lastIndexByRun.set(message.runId, index)
    })
    for (const [runId, lastIndex] of lastIndexByRun) {
      const lastMessage = messages[lastIndex]
      const lastHasTools =
        (toolCallsByMessage.get(lastMessage.id) ?? []).length > 0
      if (!lastHasTools || !activeRunIds.has(runId)) {
        finalIndexByRun.set(runId, lastIndex)
      }
    }
  }

  const items: DisplayItem[] = []
  let pending: Message[] = []

  // 未吸收的过程轮次按 Run 聚合成一条单元输出；runId 为 null 的各自独立。
  const emitPending = (): void => {
    if (pending.length === 0) return
    const groups = new Map<string, Message[]>()
    for (const m of pending) {
      const key = m.runId ?? `none-${m.id}`
      const group = groups.get(key)
      if (group) group.push(m)
      else groups.set(key, [m])
    }
    for (const group of groups.values()) {
      const last = group[group.length - 1]
      const reasoning = joinReasonings(group)
      items.push({
        message: reasoning !== last.reasoning ? { ...last, reasoning } : last,
        toolCalls: group.flatMap((m) => toolCallsByMessage.get(m.id) ?? []),
      })
    }
    pending = []
  }

  const pushPlain = (message: Message): void => {
    items.push({ message, toolCalls: toolCallsByMessage.get(message.id) ?? [] })
  }

  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.runId !== null) {
      const finalIndex = finalIndexByRun.get(message.runId)
      if (finalIndex === undefined || index !== finalIndex) {
        // 过程轮次：工具/思考归入最终回答，content（中途文本）不展示。
        pending.push(message)
        return
      }
      // 最终回答：吸收同 Run 的过程轮次后作为唯一单元输出。
      const consumed = pending.filter((m) => m.runId === message.runId)
      pending = pending.filter((m) => m.runId !== message.runId)
      emitPending()
      const reasoning = joinReasonings([...consumed, message])
      items.push({
        message:
          reasoning !== message.reasoning ? { ...message, reasoning } : message,
        toolCalls: [
          ...consumed.flatMap((m) => toolCallsByMessage.get(m.id) ?? []),
          ...(toolCallsByMessage.get(message.id) ?? []),
        ],
      })
      return
    }
    // user/system：未吸收的过程轮次先聚合并输出，保持时间顺序。
    emitPending()
    pushPlain(message)
  })
  emitPending()
  return items
}

/** 按序拼接非空思考文本，作为聚合消息的 reasoning。 */
function joinReasonings(messages: Message[]): string {
  return messages
    .map((message) => message.reasoning)
    .filter((text) => text !== '')
    .join('\n')
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const sessionId = props.sessionData?.session?.id ?? null

  const messages = props.sessionData?.messages ?? []
  const runs = props.sessionData?.runs ?? []
  const toolCalls = props.sessionData?.toolCalls ?? []
  const runIds = new Set(runs.map((run) => run.id))
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
  const activeRunIds = useMemo(
    () =>
      new Set(
        runs
          .filter(
            (run) =>
              run.status === 'created' ||
              run.status === 'running' ||
              run.status === 'awaiting_approval',
          )
          .map((run) => run.id),
      ),
    [runs],
  )
  // 过程轮次吸附到最终回答：每条工具/思考消息不再各自显示折叠行。
  const displayItems = useMemo(
    () => buildDisplayItems(messages, toolCallsByMessage, activeRunIds),
    [messages, toolCallsByMessage, activeRunIds],
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
                  runActive={runActive}
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
                  onRetry={() => void props.onRetry()}
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
        <div className="inline-banner">
          <span>
            尚未配置模型 Provider：请先在设置中填写 API Key 后再开始对话。
          </span>
          <button className="ghost" onClick={props.onGoSettings}>
            去配置
          </button>
        </div>
      )}

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
              ? '正在回复，可点击右侧停止…'
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
