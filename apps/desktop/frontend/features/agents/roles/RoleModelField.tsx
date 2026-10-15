import { useEffect, useState } from 'react'
import type {
  AgentModelBinding,
  ProviderProfile,
  ProviderModel,
  ReasoningEffort,
} from '@reflexion-os-studio/contracts'
import { listProviderModels } from '../../../api/providers'
import { Select } from '../../../components/forms/Select'

export function RoleModelField({
  value,
  profiles,
  onChange,
}: {
  value: AgentModelBinding
  profiles: ProviderProfile[]
  onChange: (value: AgentModelBinding) => void
}): React.JSX.Element {
  const [configs, setConfigs] = useState<ProviderModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const providerId = value.mode === 'fixed' ? value.providerId : null
  useEffect(() => {
    let active = true
    setConfigs([])
    setError(null)
    if (providerId)
      void listProviderModels(providerId)
        .then((result) => {
          if (active) setConfigs(result.models)
        })
        .catch((error) => {
          if (active) setError(String(error))
        })
    return () => {
      active = false
    }
  }, [providerId])
  const options = profiles
    .filter(
      (profile) => profile.enabled && profile.capabilities.includes('chat'),
    )
    .flatMap((profile) =>
      profile.models.map((model) => ({
        key: JSON.stringify([profile.id, model]),
        label: `${profile.name} / ${model}`,
      })),
    )
  const key =
    value.mode === 'fixed'
      ? JSON.stringify([value.providerId, value.model])
      : ''
  const config =
    value.mode === 'fixed'
      ? configs.find((config) => config.model === value.model)
      : null
  const profile = profiles.find((profile) => profile.id === providerId)
  const supported =
    config?.reasoningEffortSupported && profile?.apiFormat !== 'anthropic'
  return (
    <fieldset className="agent-model-field">
      <label>
        执行模型
        <Select
          value={key}
          onValueChange={(key) => {
            if (!key) onChange({ mode: 'inherit' })
            else {
              const [providerId, model] = JSON.parse(key) as [string, string]
              onChange({ mode: 'fixed', providerId, model })
            }
          }}
        >
          <option value="">继承上级模型与思考等级</option>
          {key && !options.some((option) => option.key === key) && (
            <option value={key} disabled>
              当前指定模型不可用
            </option>
          )}
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      {value.mode === 'fixed' && (
        <label>
          思考强度
          <Select
            value={
              value.reasoningEffort === undefined
                ? 'default'
                : (value.reasoningEffort ?? 'off')
            }
            disabled={!supported}
            onValueChange={(effort) =>
              onChange({
                ...value,
                reasoningEffort:
                  effort === 'default'
                    ? undefined
                    : effort === 'off'
                      ? null
                      : (effort as ReasoningEffort),
              })
            }
          >
            <option value="default">模型默认</option>
            <option value="off">不请求思考等级</option>
            {(config?.reasoningOptions ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {!supported && <small>当前模型未配置可用思考等级。</small>}
        </label>
      )}
      <small>指定模型不可用时会提示处理，不自动换模型。</small>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
