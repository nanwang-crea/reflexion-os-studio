import type {
  AgentBrowserApproval,
  ApprovalOverride,
  PermissionPreset,
} from '@reflexion-os-studio/contracts'
import type { DecisionMode } from './presets.js'

/** Automatic policies cover read-only tools; interactions always require approval. */
export function browserDecision(
  operation: string,
  policy: AgentBrowserApproval,
  preset: PermissionPreset,
  override: ApprovalOverride = 'default',
): DecisionMode {
  if (
    !['browser.navigate', 'browser.read', 'browser.close'].includes(operation)
  )
    return 'ask'
  if (override === 'ask-everything') return 'ask'
  if (policy === 'allow-read-only') return 'automatic'
  if (policy === 'follow-session' && preset === 'workspace-full')
    return 'automatic'
  return 'ask'
}
