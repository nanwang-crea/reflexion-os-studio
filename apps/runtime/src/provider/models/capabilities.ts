import {
  DEFAULT_REASONING_OPTIONS,
  type ModelReasoningCapabilities,
  type ProviderModel,
  type ProviderProfile,
} from '@reflexion-os-studio/contracts'

export function knownCapabilities(
  profile: ProviderProfile,
  model: string,
): ModelReasoningCapabilities {
  const unknown: ModelReasoningCapabilities = {
    thinking: null,
    effort: null,
    options: null,
    source: 'unknown',
    checkedAt: null,
  }
  // Exact, versioned IDs only. Compatible gateways may rename or change models.
  const host = new URL(profile.baseUrl).hostname
  if (host !== 'api.openai.com' || profile.apiFormat === 'anthropic')
    return unknown
  if (
    [
      'o3',
      'o3-2025-04-16',
      'o3-mini',
      'o3-mini-2025-01-31',
      'o4-mini',
      'o4-mini-2025-04-16',
    ].includes(model)
  )
    return {
      ...unknown,
      thinking: true,
      effort: true,
      options: DEFAULT_REASONING_OPTIONS,
      source: 'catalog',
    }
  const efforts: Record<string, string[]> = {
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
    'gpt-5-2025-08-07': ['minimal', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5.1-2025-11-13': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.2-2025-12-11': ['none', 'low', 'medium', 'high', 'xhigh'],
  }
  if (efforts[model])
    return {
      ...unknown,
      thinking: true,
      effort: true,
      options: efforts[model].map((value) => ({ label: value, value })),
      source: 'catalog',
    }
  if (
    [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4.1-2025-04-14',
      'gpt-4.1-mini-2025-04-14',
      'gpt-4.1-nano-2025-04-14',
    ].includes(model)
  )
    return { ...unknown, thinking: false, effort: false, source: 'catalog' }
  return unknown
}

/** One effective projection for settings, chat, templates and execution. */
export function effectiveProviderModel(
  profile: ProviderProfile,
  model: string,
  stored: ProviderModel | null,
): ProviderModel {
  const manual = stored != null && stored.reasoningMode !== 'auto'
  const detected =
    stored?.reasoningCapabilities ?? knownCapabilities(profile, model)
  const capabilities: ModelReasoningCapabilities = manual
    ? {
        thinking:
          stored.thinkingSupported ??
          (stored.reasoningEffortSupported ? true : null),
        effort: stored.reasoningEffortSupported,
        options: stored.reasoningOptions,
        source: 'manual',
        checkedAt: null,
      }
    : detected
  // Detection describes the model; this boolean describes what our adapter can send.
  const supported =
    capabilities.effort === true &&
    capabilities.options != null &&
    profile.apiFormat !== 'anthropic'
  return {
    providerId: profile.id,
    model,
    temperature: null,
    maxTokens: null,
    contextWindow: null,
    contextBudget: null,
    reasoningEffort: null,
    updatedAt: profile.updatedAt,
    ...stored,
    reasoningMode: manual ? 'manual' : 'auto',
    thinkingSupported: capabilities.thinking,
    reasoningCapabilities: capabilities,
    reasoningEffortSupported: supported,
    reasoningOptions: capabilities.options ?? DEFAULT_REASONING_OPTIONS,
  }
}
