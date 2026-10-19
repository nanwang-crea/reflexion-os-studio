import {
  ModelMetadataSchema,
  type ModelReasoningCapabilities,
} from '@reflexion-os-studio/contracts'
export { ModelMetadataPageSchema } from '@reflexion-os-studio/contracts'

export function parseModelMetadata(
  value: unknown,
  checkedAt: string,
): {
  model: string
  capabilities: ModelReasoningCapabilities
} | null {
  const parsed = ModelMetadataSchema.safeParse(value)
  if (!parsed.success) return null
  const item = parsed.data
  const parameters = item.supported_parameters
  const effort =
    item.capabilities?.effort?.supported ??
    (parameters
      ? parameters.includes('reasoning_effort')
        ? true
        : parameters.includes('reasoning')
          ? null
          : false
      : null)
  const thinking =
    item.capabilities?.thinking?.supported ??
    (effort === true || parameters?.includes('reasoning') ? true : null)
  const levels = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const
  const options = levels
    .filter((level) => item.capabilities?.effort?.[level]?.supported === true)
    .map((value) => ({ label: value, value }))
  if (thinking == null && effort == null) return null
  return {
    model: item.id,
    capabilities: {
      thinking,
      effort,
      options: item.reasoning_options ?? (options.length ? options : null),
      source: 'provider',
      checkedAt,
    },
  }
}
