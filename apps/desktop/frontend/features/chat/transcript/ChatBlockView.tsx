import type { ChatViewProps } from '../chat-view-types'
import type { ChatBlock } from '../chat-blocks'
import { computeRunDurationMs, isLastEditableUserMessage } from '../chat-blocks'
import type {
  Run,
  Delegation,
  RunEvent,
} from '@reflexion-os-studio/runtime-client'
import type { DelegationAttention } from '../run/DelegationList'
import { UserMessage } from '../message/UserMessage'
import { AssistantMessage } from '../message/AssistantMessage'
import { RunBlock } from '../run/RunBlock'
import { RunEventCard } from '../run/RunEventCard'

const EMPTY_DELEGATIONS: Delegation[] = []
const EMPTY_FAILED_EVENTS: RunEvent[] = []

interface Props {
  block: ChatBlock
  view: ChatViewProps
  runById: Map<string, Run>
  failedEventsByRun: Map<string, RunEvent[]>
  delegationsByRun: Map<string, Delegation[]>
  delegationAttention: Map<string, DelegationAttention>
  activeRunIds: Set<string>
  lastRetryableRun: Run | undefined
  runActive: boolean
  editMessageId: string | null
  editDraft: string
  editSaving: boolean
  onDraftChange: (value: string) => void
  cancelEdit: () => void
  saveEdit: () => Promise<void>
  startEdit: (id: string) => void
  handleRetry: () => void
}

export function ChatBlockView({
  block,
  view,
  runById,
  failedEventsByRun,
  delegationsByRun,
  delegationAttention,
  activeRunIds,
  lastRetryableRun,
  runActive,
  editMessageId,
  editDraft,
  editSaving,
  onDraftChange,
  cancelEdit,
  saveEdit,
  startEdit,
  handleRetry,
}: Props): React.JSX.Element | null {
  if (block.kind === 'run') {
    const run = runById.get(block.runId) ?? null
    const finalMessage =
      block.finalItem?.message ??
      block.processItems[block.processItems.length - 1]?.message
    // 重试事件只作内联活状态，不进时间线；失败事件渲染为失败卡。
    const runEvents = failedEventsByRun.get(block.runId) ?? EMPTY_FAILED_EVENTS
    const failureDetail = runEvents[0]
    return (
      <div key={block.runId}>
        {runEvents.map((event) => (
          <RunEventCard key={event.id} event={event} />
        ))}
        <RunBlock
          processItems={block.processItems}
          finalItem={block.finalItem}
          delegations={delegationsByRun.get(block.runId) ?? EMPTY_DELEGATIONS}
          delegationAttention={delegationAttention}
          runActive={activeRunIds.has(block.runId)}
          runActivity={view.runActivities[block.runId]}
          streaming={view.streaming}
          streamingReasoning={view.streamingReasoning}
          runDurationMs={
            finalMessage ? computeRunDurationMs(run, finalMessage) : null
          }
          runUsage={run?.usage ?? null}
          runFailed={run?.status === 'failed'}
          failureDetail={failureDetail?.errorMessage ?? null}
          canRetry={
            lastRetryableRun !== undefined &&
            lastRetryableRun.id === block.runId
          }
          onRetry={handleRetry}
          onResourceClick={view.onResourceClick}
          onOpenDiff={view.onOpenDiff}
          projectId={view.sessionData?.session?.projectId ?? ''}
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
      view.sessionData?.messages ?? [],
      runActive,
    )
    return (
      <UserMessage
        key={message.id}
        message={message}
        editing={editMessageId === message.id}
        editable={lastUserMsg}
        editDraft={editDraft}
        editSaving={editSaving}
        onDraftChange={onDraftChange}
        onCancel={cancelEdit}
        onSave={saveEdit}
        onEdit={() => startEdit(message.id)}
      />
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
          message.runId !== null ? view.runActivities[message.runId] : undefined
        }
        streamingText={view.streaming[message.id]}
        streamingReasoning={view.streamingReasoning[message.id]}
        runDurationMs={null}
        runUsage={null}
        canRetry={false}
        onRetry={handleRetry}
        onResourceClick={view.onResourceClick}
      />
    )
  }
  return (
    <div key={message.id} className="msg-system">
      {message.content}
    </div>
  )
}
