import type {
  AgentTemplate,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { resolveProvider, resolveSampling } from '../provider-resolver.js'

/** The user-owned template is the only child model override; never silently fall back. */
export function resolveRoleModel(
  store: Store,
  template: AgentTemplate | null,
  inherited: {
    profile: ProviderProfile
    apiKey: string
    model: string
    sampling: { temperature?: number; maxTokens?: number }
  },
  resolve = resolveProvider,
) {
  const binding = template?.modelBinding
  if (!binding || binding.mode === 'inherit')
    return {
      profile: inherited.profile,
      apiKey: inherited.apiKey,
      model: inherited.model,
      sampling: inherited.sampling,
    }
  const configured = store.providers.get(binding.providerId)
  if (
    !configured?.enabled ||
    !configured.capabilities.includes('chat') ||
    !configured.models.includes(binding.model)
  )
    throw new Error(
      `角色“${template!.name}”指定的模型不可用，请在 Agent 页面修改配置`,
    )
  const modelConfig = store.providerModels.get(
    binding.providerId,
    binding.model,
  )
  if (
    binding.reasoningEffort != null &&
    (!modelConfig?.reasoningEffortSupported ||
      configured.apiFormat === 'anthropic')
  )
    throw new Error(
      `角色“${template!.name}”指定的思考等级不可用，请更新角色配置`,
    )
  const resolved = resolve(
    store,
    binding.providerId,
    binding.model,
    binding.reasoningEffort,
  )
  return { ...resolved, sampling: resolveSampling(resolved.profile) }
}
