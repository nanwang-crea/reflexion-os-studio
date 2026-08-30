import { useEffect, useMemo, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import type { ComposerModelOption } from './Composer'

/**
 * 模型选择：从启用供应商派生可选模型（按供应商分组），
 * 并保证选中项始终有效（配置变更后自动回退到第一项）。
 */
export function useModelSelection(profiles: ProviderProfile[]): {
  modelOptions: ComposerModelOption[]
  selectedModelKey: string | null
  setSelectedModelKey: (key: string) => void
} {
  const modelOptions = useMemo(
    () =>
      profiles
        .filter((profile) => profile.enabled)
        .flatMap((profile) =>
          profile.models.map((model) => ({
            key: `${profile.id}::${model}`,
            label: model,
            group: profile.name,
          })),
        ),
    [profiles],
  )

  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null)

  useEffect(() => {
    if (modelOptions.length === 0) {
      if (selectedModelKey !== null) setSelectedModelKey(null)
      return
    }
    if (
      selectedModelKey === null ||
      !modelOptions.some((option) => option.key === selectedModelKey)
    ) {
      setSelectedModelKey(modelOptions[0].key)
    }
  }, [modelOptions, selectedModelKey])

  return { modelOptions, selectedModelKey, setSelectedModelKey }
}
