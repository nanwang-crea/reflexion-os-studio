import type {
  ResourceLink,
  UserQuestionAnswer,
} from '@reflexion-os-studio/runtime-client'
import type { PendingInteraction } from '../../../hooks/interactions/usePendingInteractions'
import { UserQuestionCard } from './UserQuestionCard'

export function InteractionQueue(props: {
  onResourceClick?: (link: ResourceLink) => void
  interactions: PendingInteraction[]
  onSubmit: (
    interactionId: string,
    answers: UserQuestionAnswer[],
  ) => Promise<boolean>
}): React.JSX.Element | null {
  const current = props.interactions[0]
  if (!current) return null
  return (
    <div className="interaction-queue">
      <UserQuestionCard
        key={current.interactionId}
        interaction={current}
        onSubmit={props.onSubmit}
        onResourceClick={props.onResourceClick}
      />
      {props.interactions.length > 1 && (
        <small>另有 {props.interactions.length - 1} 个问题等待处理</small>
      )}
    </div>
  )
}
