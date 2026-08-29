import { useEffect, useRef, useState } from 'react'
import type { Message } from '@reflexion-os-studio/runtime-client'
import type { SessionData } from './App'

interface ChatViewProps {
  sessionData: SessionData | null
  streaming: Record<string, string>
  hasEnabledProvider: boolean
  hasSession: boolean
  onSend: (content: string) => Promise<void>
  onStop: () => Promise<void>
  onRetry: () => Promise<void>
  onGoSettings: () => void
}

function messageText(
  message: Message,
  streaming: Record<string, string>,
): string {
  const partial = streaming[message.id]
  if (partial !== undefined) return partial
  return message.content
}

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  interrupted: '（已中断）',
  failed: '（失败）',
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = props.sessionData?.messages ?? []
  const runs = props.sessionData?.runs ?? []
  const activeRun = runs.find(
    (run) => run.status === 'created' || run.status === 'running',
  )
  const lastRetryableRun = [...runs]
    .reverse()
    .find(
      (run) =>
        run.status === 'failed' ||
        run.status === 'interrupted' ||
        run.status === 'cancelled',
    )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, props.streaming])

  const submit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || sending) return
    setDraft('')
    setSending(true)
    try {
      await props.onSend(content)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat-view">
      {!props.hasEnabledProvider && (
        <div className="provider-banner">
          <span>
            尚未配置模型 Provider：请先在设置中填写 API Key 后再开始对话。
          </span>
          <button onClick={props.onGoSettings}>去配置</button>
        </div>
      )}

      <div className="transcript">
        {messages.length === 0 && (
          <div className="empty-hint">
            {props.hasSession
              ? '发送第一条消息开始对话。'
              : '从左侧选择或新建一个会话。'}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`bubble bubble-${message.role}`}>
            <div className="bubble-content">
              {messageText(message, props.streaming)}
            </div>
            {message.status !== 'completed' && message.role === 'assistant' && (
              <div className="bubble-status">
                {MESSAGE_STATUS_LABELS[message.status] ??
                  `（${message.status}）`}
                {lastRetryableRun && lastRetryableRun.id === message.runId && (
                  <button className="link" onClick={() => void props.onRetry()}>
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <textarea
          placeholder={
            !props.hasEnabledProvider
              ? '请先在设置中配置 API Key…'
              : props.hasSession
                ? '输入消息，Enter 发送'
                : '请先新建会话…'
          }
          disabled={
            !props.hasEnabledProvider ||
            !props.hasSession ||
            activeRun !== undefined
          }
          value={draft}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        {activeRun ? (
          <button className="stop" onClick={() => void props.onStop()}>
            停止
          </button>
        ) : (
          <button
            disabled={
              !props.hasEnabledProvider ||
              !props.hasSession ||
              !draft.trim() ||
              sending
            }
            onClick={() => void submit()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
