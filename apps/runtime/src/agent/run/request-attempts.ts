import type { ProviderRequestAttempt } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { RunEventEmitter } from '../../events.js'
import type { TurnDraft } from './run-state.js'
import { redactProviderError } from '../../provider/provider-error.js'
import type { ProviderRuntimeConfig } from '../context/context.js'

/** Persist a bounded-frequency checkpoint; interrupted previews never enter model history. */
export function persistRequestAttempt(
  store: Store,
  emitter: RunEventEmitter,
  draft: TurnDraft,
  provider: ProviderRuntimeConfig,
  attempt: ProviderRequestAttempt,
): void {
  const safe = (text: string) =>
    redactProviderError(text, provider.apiKey, provider.headers)
  store.messages.recordAttempt(draft.id, {
    ...attempt,
    content: safe(draft.content),
    reasoning: safe(draft.reasoning),
  })
  // Checkpoints stay on disk; only terminal transitions need a UI refresh.
  if (attempt.status !== 'running')
    emitter.next({ type: 'message.attempt', messageId: draft.id })
}
