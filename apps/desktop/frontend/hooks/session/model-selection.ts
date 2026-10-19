import { DEFAULT_REASONING_OPTIONS } from '@reflexion-os-studio/runtime-client'
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
          reasoningUnavailableReason: supported
            ? undefined
            : profile.apiFormat === 'anthropic'
              ? '适配器暂不支持调整'
              : config?.reasoningCapabilities?.effort === null ||
                  config?.reasoningCapabilities?.source === 'unknown' ||
                  !config
                ? '能力未知'
                : config.reasoningCapabilities?.effort === true &&
                    !config.reasoningCapabilities.options
                  ? '等级未知'
                  : '不支持调整',
          reasoningEffortSupported: supported,
          reasoningOptions:
            config?.reasoningOptions ?? DEFAULT_REASONING_OPTIONS,
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
  const options = option.reasoningOptions ?? DEFAULT_REASONING_OPTIONS
  const configured = option.defaultReasoningEffort ?? null
  const defaultValue = options.some((item) => item.value === configured)
    ? configured
    : null
  return choice?.key === option.key &&
    choice.defaultValue === defaultValue &&
    (choice.value === null ||
      options.some((item) => item.value === choice.value))
    ? choice.value
    : defaultValue
}
