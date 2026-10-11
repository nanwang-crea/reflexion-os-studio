import type {
  ProviderModel,
  ProviderProfile,
  ReasoningEffort,
} from '@reflexion-os-studio/runtime-client'
import type { ComposerModelOption } from '../../components/composer/ModelSelector'

export function modelOptionsFor(
  profiles: ProviderProfile[],
  configs: ProviderModel[],
): ComposerModelOption[] {
  return profiles
    .filter((profile) => profile.enabled)
    .flatMap((profile) =>
      profile.models.map((model) => {
        const config = configs.find(
          (item) => item.providerId === profile.id && item.model === model,
        )
        const supported =
          profile.apiFormat !== 'anthropic' &&
          config?.reasoningEffortSupported === true
        return {
          key: `${profile.id}::${model}`,
          label: model,
          group: profile.name,
          reasoningEffortSupported: supported,
          defaultReasoningEffort: supported
            ? (config.reasoningEffort ?? profile.reasoningEffort)
            : null,
        }
      }),
    )
}

export interface ReasoningChoice {
  key: string | null
  defaultValue: ReasoningEffort | null
  value: ReasoningEffort | null
}

export function selectedEffort(
  option: ComposerModelOption | undefined,
  choice: ReasoningChoice | null,
): ReasoningEffort | null {
  if (!option?.reasoningEffortSupported) return null
  const defaultValue = option.defaultReasoningEffort ?? null
  return choice?.key === option.key && choice.defaultValue === defaultValue
    ? choice.value
    : defaultValue
}
