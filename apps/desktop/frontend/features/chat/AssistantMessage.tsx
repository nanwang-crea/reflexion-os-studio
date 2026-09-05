import { memo, useMemo } from 'react'
import type {
  Message,
  ResourceLink,
  ToolCall,
  Usage,
} from '@reflexion-os-studio/runtime-client'

/** 新协议字段为 label/link；旧历史数据仍可能使用 resource_link。 */
type ResourcePart =
  | { type: 'resource_link'; label: string; link: ResourceLink }
  | { type: 'resource_link'; resource_link: ResourceLink }

type MessagePart = { type: 'text'; text: string } | ResourcePart

function resourceFromPart(part: ResourcePart): ResourceLink {
  return 'link' in part ? part.link : part.resource_link
}
import { CopyButton } from '../../components/CopyButton'
import { AlertIcon } from '../../ui/icons'
import {
  MessageMarkdown,
} from '../../components/markdown/MessageMarkdown'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolTrace } from './ToolTrace'
import type { RunActivity } from '../../hooks/useAppBootstrap'

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
  /** Run 级事件驱动活动阶段；undefined 表示 Run 已结束或暂无活动。 */
  runActivity?: RunActivity
  /** reasoning 已在 Run 过程时间线中展示时隐藏，最终消息只保留正文。 */
  hideReasoning?: boolean
  /** 该消息的流式正文增量缓存；undefined 表示不在本次流式窗口内。 */
  streamingText: string | undefined
  /** 该消息的流式思考增量缓存。 */
  streamingReasoning: string | undefined
  /** 该消息所属 Run 的耗时；未结束或数据缺失时为 null。 */
  runDurationMs: number | null
  /** 该消息所属 Run 的 token 用量（各模型轮合计）；无数据时为 null。 */
  runUsage: Usage | null
  /** 该消息属于最近一个可重试的失败 Run 时展示重试入口。 */
  canRetry: boolean
  onRetry: () => void
  /** 资源引用（工作区文件/资产/外链）点击后按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

/**
 * 助手消息：思考、工具轨迹、正文与状态/操作。
 * 阶段推导：等待（无任何增量）→ 思考中 → 作答（流式光标）→ 完成。
 */
function AssistantMessageView(props: AssistantMessageProps): React.JSX.Element {
  const contentText = props.streamingText ?? props.message.content
  // Runtime 可能返回新协议 { label, link }，历史消息仍兼容 { resource_link }。
  const structuredParts = useMemo<MessagePart[]>(
    () =>
      props.streamingText === undefined
        ? (props.message.parts as unknown as MessagePart[])
        : [],
    [props.message.parts, props.streamingText],
  )
  const structuredText = structuredParts
    .map((part) =>
      part.type === 'text'
        ? part.text
        : `[${'label' in part ? part.label : resourceFromPart(part).uri}](${resourceFromPart(part).uri})`,
    )
    .join('')
  const reasoningText = props.streamingReasoning ?? props.message.reasoning
  // 正文流式光标：只看该消息是否仍在流式增量（不参与阶段判断）。
  const answerStreaming = props.runActive && props.streamingText !== undefined
  // Run 级阶段由事件驱动（runActivity），不再靠内容有无猜测阶段。
  // 连接 Provider 后首个增量到达前的空窗：用呼吸点告知“没有卡住”。
  const waiting =
    props.runActive &&
    contentText === '' &&
    reasoningText === '' &&
    props.streamingText === undefined &&
    props.streamingReasoning === undefined

  const statusLabel = MESSAGE_STATUS_LABELS[props.message.status]

  return (
    <div className="msg-assistant">
      <div className="assistant-main">
        {reasoningText !== '' && !props.hideReasoning && (
          <ReasoningBlock text={reasoningText} />
        )}
        <ToolTrace calls={props.toolCalls} runActive={props.runActive} />
        {waiting && (
          <div className="typing-dots" role="status" aria-label="正在思考">
            <span />
            <span />
            <span />
          </div>
        )}
        {contentText !== '' && (
          <div className="assistant-content">
            <MessageMarkdown
              text={structuredParts.length > 0 ? structuredText : contentText}
              caret={answerStreaming}
              onResourceClick={props.onResourceClick}
            />
          </div>
        )}
        {statusLabel && (
          <div className="assistant-error">
            <span className="assistant-error-icon" aria-hidden="true">
              <AlertIcon size={15} />
            </span>
            <span className="assistant-error-text">{statusLabel}</span>
            {props.canRetry && (
              <button
                type="button"
                className="assistant-retry"
                onClick={() => void props.onRetry()}
              >
                重试
              </button>
            )}
          </div>
        )}
        {props.message.status === 'completed' &&
          contentText !== '' &&
          props.runUsage !== null && (
            <div className="assistant-usage">
              {props.runUsage.promptTokens} 输入 ·{' '}
              {props.runUsage.completionTokens} 输出 tokens
              {props.runDurationMs !== null &&
                ` · ${formatSeconds(props.runDurationMs)}`}
            </div>
          )}
      </div>
      {contentText !== '' && (
        <div className="assistant-actions">
          <CopyButton
            text={structuredParts.length > 0 ? structuredText : contentText}
          />
        </div>
      )}
    </div>
  )
}

export const AssistantMessage = memo(AssistantMessageView)
