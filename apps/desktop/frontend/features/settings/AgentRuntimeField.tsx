import { AgentUnlimitedLimitSchema } from '@reflexion-os-studio/contracts'
import { contractRangeHint } from '@reflexion-os-studio/runtime-client'
import { Select } from '../../components/forms/Select'
import type { AgentRuntimeField as Field } from './agent-runtime-fields'

export type LimitMode = 'default' | 'custom' | 'unlimited'
export const UNLIMITED_FIELDS: readonly string[] =
  AgentUnlimitedLimitSchema.options

export function AgentRuntimeField({
  field,
  value,
  mode,
  onValue,
  onMode,
  disabled,
}: {
  field: Field
  value: string
  mode: LimitMode
  onValue: (value: string) => void
  onMode: (mode: LimitMode) => void
  disabled: boolean
}): React.JSX.Element {
  const optionalLimit = UNLIMITED_FIELDS.includes(field.key)
  const range = contractRangeHint('agent_settings.update', field.path)
  const id = `runtime-${field.key}`
  return (
    <div className="field">
      <label htmlFor={optionalLimit ? `${id}-mode` : id}>{field.label}</label>
      {optionalLimit && (
        <Select
          id={`${id}-mode`}
          aria-label={`${field.label}模式`}
          value={mode}
          onValueChange={(value) => onMode(value as LimitMode)}
          disabled={disabled}
        >
          <option value="default">使用默认值</option>
          <option value="custom">自定义上限</option>
          <option value="unlimited">不限制</option>
        </Select>
      )}
      {(!optionalLimit || mode === 'custom') && (
        <input
          id={id}
          aria-label={field.label}
          type="number"
          min={0}
          step={1}
          value={value}
          disabled={disabled}
          placeholder={
            mode === 'unlimited' ? '不设置此项应用级上限' : field.placeholder
          }
          onChange={(event) => onValue(event.target.value)}
        />
      )}
      <span className="field-hint">
        {optionalLimit
          ? mode === 'unlimited'
            ? '已取消此项应用级上限。'
            : mode === 'default'
              ? `默认值：${field.placeholder.replace('（默认）', '').replace('（默认，2 小时）', '（2 小时）')}。`
              : range
                ? `自定义范围：${range}。`
                : ''
          : range
            ? `范围：${range}。`
            : ''}
        {field.description}
      </span>
    </div>
  )
}
