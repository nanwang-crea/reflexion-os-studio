import type { Message, ToolCall } from '@reflexion-os-studio/runtime-client'
import { MarkdownCore } from '../../../components/markdown/md-core'
import { ReasoningBlock } from '../message/ReasoningBlock'
import { ToolTrace } from '../message/ToolTrace'

export interface ProcessItem {
  message: Message
  toolCalls: ToolCall[]
}

interface RunProcessProps {
  items: ProcessItem[]
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runActive: boolean
  reasoningOnlyMessageIds?: Set<string>
}

export function RunProcess(props: RunProcessProps): React.JSX.Element {
  const parts: Array<{
    key: string
    text: string
    reasoning: string
    thinking: boolean
    calls: ToolCall[]
  }> = []
  for (const { message, toolCalls } of props.items) {
    const text = props.reasoningOnlyMessageIds?.has(message.id)
      ? ''
      : (props.streaming[message.id] ?? message.content)
    const reasoning = props.streamingReasoning[message.id] ?? message.reasoning
    const previous = parts.at(-1)
    // Only invisible message boundaries can be merged; commentary keeps its place.
    if (text === '' && reasoning === '' && previous) {
      previous.calls.push(...toolCalls)
    } else if (text !== '' || reasoning !== '' || toolCalls.length > 0) {
      parts.push({
        key: message.id,
        text,
        reasoning,
        thinking:
          props.runActive && props.streamingReasoning[message.id] !== undefined,
        calls: [...toolCalls],
      })
    }
  }
  return (
    <div className="run-process-timeline">
      {parts.map((part) => (
        <div className="run-process-part" key={part.key}>
          {part.reasoning !== '' && (
            <ReasoningBlock text={part.reasoning} active={part.thinking} />
          )}
          {part.text !== '' && (
            <div className="run-process-text">
              <MarkdownCore text={part.text} />
            </div>
          )}
          <ToolTrace calls={part.calls} runActive={props.runActive} />
        </div>
      ))}
    </div>
  )
}
