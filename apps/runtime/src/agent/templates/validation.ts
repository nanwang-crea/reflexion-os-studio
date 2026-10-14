import type { AgentTemplateSaveParams } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { containsSecretLike } from '../instructions/secretGuard.js'
import { resolveModelRuntimeConfig } from '../provider-resolver.js'

/** Shared validation for UI authoring and model-driven team creation. */
export function validateRoleTemplate(
  store: Store,
  input: Omit<AgentTemplateSaveParams, 'requestId'>,
): void {
  if (
    [
      input.name,
      input.description,
      input.systemPrompt,
      ...(input.domains ?? []),
    ].some(containsSecretLike)
  )
    throw new Error('角色指令疑似包含机密，拒绝保存')
  if (input.projectId && !store.projects.get(input.projectId))
    throw new Error('项目不存在')
  const binding = input.modelBinding
  if (binding?.mode !== 'fixed') return
  const profile = store.providers.get(binding.providerId)
  if (
    !profile?.enabled ||
    !profile.capabilities.includes('chat') ||
    !profile.models.includes(binding.model)
  )
    throw new Error('角色指定的模型不可用，请检查 Provider 配置')
  const config = store.providerModels.get(profile.id, binding.model)
  if (
    binding.reasoningEffort != null &&
    (!config?.reasoningEffortSupported || profile.apiFormat === 'anthropic')
  )
    throw new Error('角色指定的思考等级不受当前模型支持')
  resolveModelRuntimeConfig(profile, config, binding.reasoningEffort)
}
