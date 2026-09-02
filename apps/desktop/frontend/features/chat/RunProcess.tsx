import type { Message, ToolCall } from '@reflexion-os-studio/runtime-client'
import { MessageMarkdown } from '../../components/markdown/MessageMarkdown'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolTrace } from './ToolTrace'

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
  return (
    <div className="run-process-timeline">
      {props.items.map(({ message, toolCalls }) => {
        const text = props.streaming[message.id] ?? message.content
        const reasoning =
          props.streamingReasoning[message.id] ?? message.reasoning
        if (text === '' && reasoning === '' && toolCalls.length === 0) {
          return null
        }
        return (
          <div className="run-process-part" key={message.id}>
            {reasoning !== '' && <ReasoningBlock text={reasoning} />}
            {text !== '' && !props.reasoningOnlyMessageIds?.has(message.id) && (
              <div className="run-process-text">
                <MessageMarkdown text={text} />
              </div>
            )}
            <ToolTrace calls={toolCalls} runActive={props.runActive} />
          </div>
        )
      })}
    </div>
  )
}
