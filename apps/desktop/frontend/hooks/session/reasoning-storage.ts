import { ReasoningEffortSchema } from '@reflexion-os-studio/contracts'
import type { ReasoningChoice } from './model-selection'

const STORAGE_PREFIX = 'reflexion.reasoning-choice.v1:'
// Store the configured default with the override so changed defaults invalidate it.
const StoredChoiceSchema = ReasoningEffortSchema.nullable().array().length(2)

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadReasoningChoice(
  key: string,
  storage?: PreferenceStorage,
): ReasoningChoice | null {
  try {
    const stored = (storage ?? globalThis.localStorage).getItem(
      STORAGE_PREFIX + key,
    )
    if (stored === null) return null
    const parsed = StoredChoiceSchema.safeParse(JSON.parse(stored))
    if (!parsed.success) return null
    return { key, defaultValue: parsed.data[0], value: parsed.data[1] }
  } catch {
    return null
  }
}

export function saveReasoningChoice(
  choice: ReasoningChoice,
  storage?: PreferenceStorage,
): void {
  if (choice.key === null) return
  try {
    const target = storage ?? globalThis.localStorage
    target.setItem(
      STORAGE_PREFIX + choice.key,
      JSON.stringify([choice.defaultValue, choice.value]),
    )
  } catch {
    // Storage availability must not prevent sending with the current selection.
  }
}
