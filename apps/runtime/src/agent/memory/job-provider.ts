import type { Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { loadSecret } from '../../secrets.js'
import type { ProviderRuntimeConfig } from '../context.js'

/**
 * Job 执行时的 Provider 解析：只保存 runId 的 job 经 Run.providerId
 * 解析当前 SecretRef（密钥轮换后取到新值），不持久化任何机密。
 * Provider 已删除/禁用返回 null（job 标记永久失败）。
 */
export function resolveProviderForRun(
  store: Store,
  run: Run,
): ProviderRuntimeConfig | null {
  if (run.providerId === null) return null
  const profile = store.providers.get(run.providerId)
  if (profile === null || !profile.enabled) return null
  const apiKey = loadSecret(profile.secretRef)
  if (apiKey === undefined) return null
  return {
    baseUrl: profile.baseUrl,
    apiKey,
    model: run.model ?? profile.models[0] ?? '',
    ...(profile.temperature !== null
      ? { temperature: profile.temperature }
      : {}),
    ...(profile.maxTokens !== null ? { maxTokens: profile.maxTokens } : {}),
  }
}
