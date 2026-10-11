import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  ProviderModel,
  ReasoningEffort,
} from '@reflexion-os-studio/runtime-client'
import type { ComposerModelOption } from '../components/Composer'
import { listProviderModels } from '../api/providers'
import type { ReasoningSelection } from '../components/composer/ModelSelector'
import {
  modelOptionsFor,
  selectedEffort,
  type ReasoningChoice,
} from './session/model-selection'
import type { SessionData } from '../api/sessions'

/**
 * 模型选择：从启用供应商派生可选模型（按供应商分组），并保证选中项始终
 * 有效（配置变更后自动回退到第一项）。打开会话时选择器同步为该会话最近
 * 一次 Run 实际使用的模型（每次发送都会在 Run 上记录 provider/model）；
 * 无 Run 或对应配置已失效时保留全局选择。
 */
export function useModelSelection(
  profiles: ProviderProfile[],
  sessionData: SessionData | null,
  activeSessionId: string | null,
): {
  modelOptions: ComposerModelOption[]
  reasoningSelection: ReasoningSelection
  requestedReasoningEffort?: ReasoningEffort | null
  selectedModelKey: string | null
  setSelectedModelKey: (key: string) => void
} {
  const [configs, setConfigs] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<ReasoningChoice | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void Promise.all(
      profiles
        .filter((profile) => profile.enabled)
        .map((profile) => listProviderModels(profile.id)),
    )
      .then((results) => {
        if (active) setConfigs(results.flatMap((result) => result.models))
      })
      .catch((caught) => {
        if (active) {
          setConfigs([])
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [profiles])
  const modelOptions = useMemo(
    () => modelOptionsFor(profiles, configs),
    [profiles, configs],
  )
  const [selectedModelKey, setModelKey] = useState<string | null>(null)
  const setSelectedModelKey = useCallback((key: string | null) => {
    setModelKey(key)
    setChoice(null)
  }, [])
  const selected = modelOptions.find(
    (option) => option.key === selectedModelKey,
  )
  const defaultValue = selected?.defaultReasoningEffort ?? null
  const value = selectedEffort(selected, choice)
  const onReasoningChange = useCallback(
    (value: ReasoningEffort | null) => {
      setChoice({ key: selectedModelKey, defaultValue, value })
    },
    [selectedModelKey, defaultValue],
  )
  const supported =
    selected?.reasoningEffortSupported === true && !loading && error === null
  const reasoningSelection = {
    value: supported ? value : null,
    supported,
    loading,
    error,
    onChange: onReasoningChange,
  }
  const syncedSessionRef = useRef<string | null>(null)

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
  }, [modelOptions, selectedModelKey, setSelectedModelKey])

  // 会话数据落地后做一次性同步；等待供应商列表加载完成（选项非空）才开始，
  // 避免在选项就绪前标记已同步、之后不再生效。会话中途手动换模型不受影响
  // （Run 结束刷新不会重新触发：同一会话只同步一次）。
  useEffect(() => {
    if (activeSessionId === null) {
      syncedSessionRef.current = null
      return
    }
    const session = sessionData?.session
    if (!session || session.id !== activeSessionId) return
    if (syncedSessionRef.current === activeSessionId) return
    if (modelOptions.length === 0) return
    syncedSessionRef.current = activeSessionId
    const runs = sessionData?.runs ?? []
    const lastRun = runs[runs.length - 1]
    if (!lastRun?.providerId || !lastRun.model) return
    const key = `${lastRun.providerId}::${lastRun.model}`
    if (
      key !== selectedModelKey &&
      modelOptions.some((option) => option.key === key)
    ) {
      setSelectedModelKey(key)
    }
  }, [
    sessionData,
    activeSessionId,
    modelOptions,
    selectedModelKey,
    setSelectedModelKey,
  ])

  return {
    modelOptions,
    selectedModelKey,
    setSelectedModelKey,
    reasoningSelection,
    requestedReasoningEffort: supported ? value : undefined,
  }
}
