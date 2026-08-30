import { useEffect, useState } from 'react'
import type { Message, ToolCall } from '@reflexion-os-studio/runtime-client'
import { CheckIcon, CopyIcon } from '../../ui/icons'
import { MessageMarkdown } from './MessageMarkdown'
import { ThinkingPanel } from './ThinkingPanel'
import { ToolTraceCard } from './ToolTraceCard'

const MESSAGE_STATUS_LABELS: Record<string, string> = {
  interrupted: '已中断',
  failed: '回复失败',
}

interface AssistantMessageProps {
  message: Message
  /** 该消息发起的工具调用；纯工具轮次只有轨迹卡没有正文。 */
  toolCalls: ToolCall[]
  /** 会话内是否有进行中的 Run；配合流式缓存区分等待/思考/作答阶段。 */
  runActive: boolean
  /** 该消息的流式正文增量缓存；undefined 表示不在本次流式窗口内。 */
  streamingText: string | undefined
  /** 该消息的流式思考增量缓存。 */
  streamingReasoning: string | undefined
  /** 该消息属于最近一个可重试的失败 Run 时展示重试入口。 */
  canRetry: boolean
  onRetry: () => void
}

/**
 * 助手消息：思考面板（有思考内容时）+ 正文 + 状态/操作。
 * 阶段推导：等待（无任何增量）→ 思考中 → 作答（流式光标）→ 完成。
 */
export function AssistantMessage(
  props: AssistantMessageProps,
): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const contentText = props.streamingText ?? props.message.content
  const reasoningText = props.streamingReasoning ?? props.message.reasoning
  const answerStreaming = props.runActive && props.streamingText !== undefined
  const thinkingStreaming =
    props.runActive &&
    props.streamingReasoning !== undefined &&
    props.streamingText === undefined
  // 连接 Provider 后首个增量到达前的空窗：用呼吸点告知“没有卡住”。
  const waiting =
    props.runActive &&
    contentText === '' &&
    reasoningText === '' &&
    props.streamingText === undefined &&
    props.streamingReasoning === undefined

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.message.content)
      setCopied(true)
    } catch {
      // 剪贴板不可用时静默失败，不打断阅读。
    }
  }

  const statusLabel = MESSAGE_STATUS_LABELS[props.message.status]

  return (
    <div className="msg-assistant">
      <div className="assistant-main">
        {props.toolCalls.length > 0 && (
          <ToolTraceCard
            toolCalls={props.toolCalls}
            runActive={props.runActive}
          />
        )}
        {reasoningText !== '' && (
          <ThinkingPanel text={reasoningText} streaming={thinkingStreaming} />
        )}
        {waiting && (
          <div className="typing-dots" role="status" aria-label="正在思考">
            <span />
            <span />
            <span />
          </div>
        )}
        {contentText !== '' && (
          <div className="assistant-content">
            <MessageMarkdown text={contentText} caret={answerStreaming} />
          </div>
        )}
        {statusLabel && (
          <div className="assistant-meta">
            <span className="assistant-status">{statusLabel}</span>
            {props.canRetry && (
              <button className="link" onClick={() => void props.onRetry()}>
                重新生成
              </button>
            )}
          </div>
        )}
        {props.message.status === 'completed' && contentText !== '' && (
          <div className="assistant-actions">
            <button
              className="msg-action"
              title={copied ? '已复制' : '复制'}
              aria-label={copied ? '已复制' : '复制'}
              onClick={() => void copy()}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
