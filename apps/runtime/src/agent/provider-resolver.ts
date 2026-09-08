import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import { loadSecret } from '../secrets.js'
import type { Store } from '../store/index.js'
import { CommandError } from './errors.js'

export interface ResolvedProvider {
  profile: ProviderProfile
  apiKey: string
  model: string
}

/** 解析本次对话使用的 Provider 与模型；不指定时回退到启用的 Provider 第一个模型。 */
export function resolveProvider(
  store: Store,
  providerId?: string,
  model?: string,
): ResolvedProvider {
  const profile = providerId
    ? store.providers.get(providerId)
    : store.providers.getEnabled()
  if (!profile) {
    throw new CommandError(
      'configuration',
      providerId
        ? `未找到模型 Provider：${providerId}`
        : '未配置可用的模型 Provider，请先在设置中配置 API Key',
    )
  }
  if (!profile.enabled) {
    throw new CommandError(
      'configuration',
      `模型 Provider 已禁用：${profile.name}`,
    )
  }
  const apiKey = loadSecret(profile.secretRef)
  if (!apiKey) {
    throw new CommandError(
      'configuration',
      'Provider 密钥缺失，请重新在设置中保存 API Key',
    )
  }
  const resolvedModel = model ?? profile.models[0]
  if (!resolvedModel) {
    throw new CommandError(
      'configuration',
      `Provider 未配置模型：${profile.name}`,
    )
  }
  return { profile, apiKey, model: resolvedModel }
}

/** 模型采样参数：消息级覆盖优先，缺省用 Provider 配置。 */
export function resolveSampling(
  profile: ProviderProfile,
  overrides: { temperature?: number; maxTokens?: number },
): { temperature?: number; maxTokens?: number } {
  const resolved: { temperature?: number; maxTokens?: number } = {}
  if (overrides.temperature !== undefined) {
    resolved.temperature = overrides.temperature
  } else if (profile.temperature !== null) {
    resolved.temperature = profile.temperature
  }
  if (overrides.maxTokens !== undefined) {
    resolved.maxTokens = overrides.maxTokens
  } else if (profile.maxTokens !== null) {
    resolved.maxTokens = profile.maxTokens
  }
  return resolved
}
