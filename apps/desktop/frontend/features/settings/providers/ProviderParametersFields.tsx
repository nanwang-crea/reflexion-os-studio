import type { ReasoningEffort } from '@reflexion-os-studio/runtime-client'
import { Select } from '../../../components/forms/Select'
import type { Draft } from '../provider-form'
import { samplingHint } from '../provider-form'

type ParametersDraft = Pick<
  Draft,
  | 'temperature'
  | 'maxTokens'
  | 'contextWindow'
  | 'contextBudget'
  | 'reasoningEffort'
>

const FIELDS = [
  {
    key: 'temperature',
    label: '温度',
    integer: false,
    placeholder: '服务端默认',
  },
  {
    key: 'maxTokens',
    label: '最大输出 tokens',
    integer: true,
    placeholder: '服务端默认',
  },
  {
    key: 'contextWindow',
    label: '上下文窗口 tokens',
    integer: true,
    placeholder: '保守默认预算',
  },
  {
    key: 'contextBudget',
    label: '上下文预算上限 tokens',
    integer: true,
    placeholder: '64000',
  },
] as const

export function ProviderParametersFields(props: {
  draft: ParametersDraft
  onChange: (patch: Partial<ParametersDraft>) => void
  apiFormat?: Draft['apiFormat']
  inherited?: boolean
  disabled?: boolean
  reasoningDisabled?: boolean
}): React.JSX.Element {
  return (
    <div className="sampling-grid">
      {FIELDS.map(({ key, label, integer, placeholder }) => (
        <label
          className={`field${key === 'contextWindow' || key === 'contextBudget' ? ' sampling-wide' : ''}`}
          key={key}
        >
          {label}
          <input
            type="number"
            disabled={props.disabled}
            min={integer ? 1 : 0}
            max={integer ? undefined : 2}
            step={integer ? 1 : 0.1}
            value={props.draft[key]}
            placeholder={props.inherited ? '继承 Provider 默认' : placeholder}
            onChange={(event) => props.onChange({ [key]: event.target.value })}
          />
          <span className="field-hint">
            {samplingHint(
              key,
              props.inherited ? '留空继承 Provider 默认' : '留空使用默认值',
            )}
          </span>
        </label>
      ))}
      {props.apiFormat === 'anthropic' && (
        <p className="field-hint">最大输出留空时固定使用 4096 tokens。</p>
      )}
      <label className="field">
        思考强度
        <Select
          aria-label="思考强度"
          value={props.draft.reasoningEffort}
          disabled={props.disabled || props.reasoningDisabled}
          onValueChange={(value) =>
            props.onChange({ reasoningEffort: value as ReasoningEffort | '' })
          }
        >
          <option value="">
            {props.inherited ? '继承 Provider 默认' : '自动'}
          </option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </Select>
        <span className="field-hint">仅对明确支持思考强度的模型发送。</span>
      </label>
    </div>
  )
}
