import type {
  ProviderProfile,
  ProviderModel,
  ReasoningEffort,
} from '@reflexion-os-studio/contracts'
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
  requestedReasoningEffort?: ReasoningEffort | null,
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
  const config = store.providerModels.get(profile.id, resolvedModel)
  const effectiveProfile = resolveModelRuntimeConfig(
    profile,
    config,
    requestedReasoningEffort,
  )
  return { profile: effectiveProfile, apiKey, model: resolvedModel }
}

/** 可测试的配置解析边界；UI 意图仅覆盖能力允许的思考强度。 */
export function resolveModelRuntimeConfig(
  profile: ProviderProfile,
  config: ProviderModel | null,
  requestedReasoningEffort?: ReasoningEffort | null,
): ProviderProfile {
  return {
    ...profile,
    temperature: config?.temperature ?? profile.temperature,
    maxTokens: config?.maxTokens ?? profile.maxTokens,
    contextWindow: config?.contextWindow ?? profile.contextWindow,
    contextBudget: config?.contextBudget ?? profile.contextBudget,
    reasoningEffort:
      config?.reasoningEffortSupported && profile.apiFormat !== 'anthropic'
        ? requestedReasoningEffort === undefined
          ? (config.reasoningEffort ?? profile.reasoningEffort)
          : requestedReasoningEffort
        : null,
  }
}

/** 参数已在 resolveProvider 按模型覆盖 → Provider 默认合并。 */
export function resolveSampling(profile: ProviderProfile): {
  temperature?: number
  maxTokens?: number
} {
  return {
    ...(profile.temperature !== null
      ? { temperature: profile.temperature }
      : {}),
    ...(profile.maxTokens !== null ? { maxTokens: profile.maxTokens } : {}),
  }
}
