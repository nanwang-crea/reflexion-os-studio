import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolCall } from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from './Composer'
import { ArrowDownIcon, SparkIcon } from './ui/icons'
import { ApprovalCard } from './chat/ApprovalCard'
import { AssistantMessage } from './chat/AssistantMessage'
import type { SessionData } from './api/sessions'
import type { PendingApproval } from './useAppBootstrap'

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

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const sessionId = props.sessionData?.session?.id ?? null

  const messages = props.sessionData?.messages ?? []
  const runs = props.sessionData?.runs ?? []
  const toolCalls = props.sessionData?.toolCalls ?? []
  const runIds = new Set(runs.map((run) => run.id))
  // 工具调用按发起消息分组，随助手消息渲染轨迹卡片。
  const toolCallsByMessage = new Map<string, ToolCall[]>()
  for (const call of toolCalls) {
    if (call.messageId === null) continue
    const group = toolCallsByMessage.get(call.messageId)
    if (group) group.push(call)
    else toolCallsByMessage.set(call.messageId, [call])
  }
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
              发送第一条消息开始对话。
            </div>
          )}
          {messages.map((message) => {
            const messageToolCalls = toolCallsByMessage.get(message.id) ?? []
            // 既无正文/思考也无工具调用的占位消息不渲染。
            if (
              message.role === 'assistant' &&
              message.status === 'completed' &&
              message.content === '' &&
              message.reasoning === '' &&
              messageToolCalls.length === 0
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
                  toolCalls={messageToolCalls}
                  runActive={runActive}
                  streamingText={props.streaming[message.id]}
                  streamingReasoning={props.streamingReasoning[message.id]}
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
                : '输入消息，Enter 发送'
          }
          disabled={!props.hasEnabledProvider}
          busy={runActive}
          permissionValue={props.permissionValue}
          onPermissionChange={props.onPermissionChange}
          modelOptions={props.modelOptions}
          selectedModelKey={props.selectedModelKey}
          onModelChange={props.onModelChange}
          onSend={props.onSend}
          onStop={props.onStop}
        />
      </div>
    </div>
  )
}
