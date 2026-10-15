import type {
  AgentSettings,
  AgentUnlimitedLimit,
} from '@reflexion-os-studio/contracts'

/** Infinity stays internal: persisted settings and execution snapshots use null/flags. */
export function runLimit(
  settings: AgentSettings,
  key: AgentUnlimitedLimit,
  fallback: number,
): number {
  return settings.unlimitedLimits?.includes(key)
    ? Infinity
    : (settings[key] ?? fallback)
}

export function childLimit(
  settings: AgentSettings,
  key: 'maxChildRuns' | 'maxChildTimeoutSec' | 'maxChildTotalTokens',
): number | null {
  if (settings.unlimitedLimits?.includes(key)) return null
  if (key === 'maxChildRuns') return settings[key] ?? 4
  return key === 'maxChildTotalTokens'
    ? (settings[key] ?? 12000)
    : settings[key]
}

export function limitSettingsHint(field: string, group = '循环'): string {
  return `可前往「设置 → Agent 运行时 → ${group}」调整「${field}」或选择“不限制”；保存后重新发起任务。`
}
