import { useEffect, useRef } from 'react'
import type { Message } from '@reflexion-os-studio/runtime-client'
import { Composer, type ComposerModelOption } from './Composer'
import type { SessionData } from './api/sessions'

interface ChatViewProps {
  sessionData: SessionData | null
  streaming: Record<string, string>
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

  return (
    <div className="chat-view">
      <div className="chat-scroll">
        <div className="transcript">
          {messages.length === 0 && (
            <div className="empty-hint">发送第一条消息开始对话。</div>
          )}
          {messages.map((message) => (
            <div key={message.id} className={`bubble bubble-${message.role}`}>
              <div className="bubble-content">
                {messageText(message, props.streaming)}
              </div>
              {message.status !== 'completed' &&
                message.role === 'assistant' && (
                  <div className="bubble-status">
                    {MESSAGE_STATUS_LABELS[message.status] ??
                      `（${message.status}）`}
                    {lastRetryableRun &&
                      lastRetryableRun.id === message.runId && (
                        <button
                          className="link"
                          onClick={() => void props.onRetry()}
                        >
                          重试
                        </button>
                      )}
                  </div>
                )}
            </div>
          ))}
          <div ref={bottomRef} />
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
        <Composer
          placeholder={
            activeRun
              ? '正在回复，可点击右侧停止…'
              : !props.hasEnabledProvider
                ? '请先在设置中配置 API Key…'
                : '输入消息，Enter 发送'
          }
          disabled={!props.hasEnabledProvider}
          busy={activeRun !== undefined}
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
