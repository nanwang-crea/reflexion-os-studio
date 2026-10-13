import { useEffect, useMemo, useState } from 'react'
import type {
  ProviderModel,
  ProviderProfile,
} from '@reflexion-os-studio/runtime-client'
import {
  formatFieldFeedbacks,
  validateCommandParams,
} from '@reflexion-os-studio/runtime-client'
import {
  configureProviderModel,
  deleteProviderModel,
  listProviderModels,
} from '../../../api/providers'
import { Select } from '../../../components/forms/Select'
import { ProviderParametersFields } from './ProviderParametersFields'
import { parseNumber, type Draft } from '../provider-form'

type ModelDraft = Pick<
  Draft,
  | 'temperature'
  | 'maxTokens'
  | 'contextWindow'
  | 'contextBudget'
  | 'reasoningEffort'
> & {
  reasoningOptionsText: string
  reasoningEffortSupported: boolean
}

function draftFor(config?: ProviderModel): ModelDraft {
  return {
    temperature: config?.temperature == null ? '' : String(config.temperature),
    maxTokens: config?.maxTokens == null ? '' : String(config.maxTokens),
    contextWindow:
      config?.contextWindow == null ? '' : String(config.contextWindow),
    contextBudget:
      config?.contextBudget == null ? '' : String(config.contextBudget),
    reasoningEffort: config?.reasoningEffort ?? '',
    reasoningOptionsText: (
      config?.reasoningOptions ?? [
        { label: '低', value: 'low' },
        { label: '中', value: 'medium' },
        { label: '高', value: 'high' },
      ]
    )
      .map((option) => `${option.label}=${option.value}`)
      .join('\n'),
    reasoningEffortSupported: config?.reasoningEffortSupported ?? false,
  }
}

export function ProviderModelsPanel({
  profile,
  onSaved,
}: {
  profile: ProviderProfile
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [configs, setConfigs] = useState<ProviderModel[]>([])
  const [model, setModel] = useState(profile.models[0] ?? '')
  const [draft, setDraft] = useState<ModelDraft>(draftFor())
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const providerId = profile.id
  const models = useMemo(
    () => [
      ...new Set([...profile.models, ...configs.map((config) => config.model)]),
    ],
    [profile.models, configs],
  )

  useEffect(() => {
    let active = true
    setLoaded(false)
    void listProviderModels(providerId)
      .then(({ models }) => {
        if (!active) return
        setConfigs(models)
        setLoaded(true)
      })
      .catch((caught) => {
        if (active)
          setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      active = false
    }
  }, [providerId])

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0] ?? '')
  }, [models, model])

  useEffect(() => {
    setDraft(draftFor(configs.find((config) => config.model === model)))
  }, [configs, model])

  useEffect(() => {
    setSaved(false)
  }, [model])

  const reasoningOptions = draft.reasoningOptionsText
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const separator = line.indexOf('=')
      return separator < 0
        ? { label: line.trim(), value: line.trim() }
        : {
            label: line.slice(0, separator).trim(),
            value: line.slice(separator + 1).trim(),
          }
    })

  const persist = async (reset: boolean): Promise<void> => {
    if (busy || !loaded || !model) return
    const payload = {
      providerId,
      model,
      temperature: parseNumber(draft.temperature, false),
      maxTokens: parseNumber(draft.maxTokens, true),
      contextWindow: parseNumber(draft.contextWindow, true),
      contextBudget: parseNumber(draft.contextBudget, true),
      reasoningEffort: draft.reasoningEffort || null,
      reasoningOptions,
      reasoningEffortSupported:
        profile.apiFormat !== 'anthropic' && draft.reasoningEffortSupported,
    }
    const feedback = validateCommandParams('provider.model.configure', {
      requestId: 'preflight',
      ...payload,
    })
    if (!reset && feedback) {
      setError(formatFieldFeedbacks(feedback))
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      if (reset) await deleteProviderModel(providerId, model)
      else await configureProviderModel(payload)
      const result = await listProviderModels(providerId)
      setConfigs(result.models)
      await onSaved()
      setSaved(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h4>模型独立配置</h4>
      <p className="field-hint">
        仅覆盖所选模型的参数，留空继承供应商默认。对话选择模型后自动使用这里的配置。
      </p>
      <label className="field">
        模型
        <Select
          aria-label="配置模型"
          value={model}
          disabled={busy || !loaded}
          onValueChange={setModel}
        >
          {models.map((item) => (
            <option key={item} value={item}>
              {item}
              {profile.models.includes(item) ? '' : '（已移出模型列表）'}
            </option>
          ))}
        </Select>
      </label>
      <label className="field">
        <span>
          <input
            type="checkbox"
            checked={draft.reasoningEffortSupported}
            disabled={busy || !loaded || profile.apiFormat === 'anthropic'}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                reasoningEffortSupported: event.target.checked,
              }))
              setSaved(false)
            }}
          />
          模型支持思考强度
        </span>
      </label>
      <label className="field">
        支持的思考等级
        <textarea
          aria-label="支持的思考等级"
          rows={5}
          value={draft.reasoningOptionsText}
          disabled={busy || !loaded || profile.apiFormat === 'anthropic'}
          onChange={(event) => {
            setDraft((current) => ({
              ...current,
              reasoningOptionsText: event.target.value,
              reasoningEffort: '',
            }))
            setSaved(false)
          }}
        />
        <span className="field-hint">
          每行填写“显示名称=实际发送值”，例如“极高=xhigh”。默认不发送参数；关闭思考需填写服务端明确支持的值。
        </span>
      </label>
      <ProviderParametersFields
        reasoningOptions={reasoningOptions}
        draft={draft}
        inherited
        disabled={busy || !loaded}
        reasoningDisabled={
          !draft.reasoningEffortSupported || profile.apiFormat === 'anthropic'
        }
        onChange={(patch) => {
          setDraft((current) => ({ ...current, ...patch }))
          setSaved(false)
        }}
      />
      <div className="form-actions">
        <button
          className="primary"
          disabled={
            busy || !loaded || !model || !profile.models.includes(model)
          }
          onClick={() => void persist(false)}
        >
          保存模型配置
        </button>
        <button
          className="ghost"
          disabled={busy || !loaded || !model}
          onClick={() => void persist(true)}
        >
          恢复默认
        </button>
        {saved && <span className="saved">已保存</span>}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  )
}
