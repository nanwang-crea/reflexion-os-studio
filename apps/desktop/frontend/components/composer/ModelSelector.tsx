import type { ReasoningEffort } from '@reflexion-os-studio/runtime-client'
import { Select } from '../forms/Select'
import { ChevronIcon } from '../../ui/icons'

export interface ComposerModelOption {
  key: string
  label: string
  group: string
  reasoningEffortSupported?: boolean
  defaultReasoningEffort?: ReasoningEffort | null
}

export interface ReasoningSelection {
  value: ReasoningEffort | null
  supported: boolean
  loading: boolean
  error: string | null
  onChange: (value: ReasoningEffort | null) => void
}

export function ModelSelector(props: {
  options: ComposerModelOption[]
  selectedKey: string | null
  onModelChange: (key: string) => void
  reasoning?: ReasoningSelection
}): React.JSX.Element {
  const groups = new Map<string, ComposerModelOption[]>()
  for (const option of props.options) {
    const options = groups.get(option.group) ?? []
    options.push(option)
    groups.set(option.group, options)
  }
  return (
    <>
      <label className="composer-select model" title="对话使用的模型">
        <Select
          aria-label="对话模型"
          value={props.selectedKey ?? ''}
          onValueChange={props.onModelChange}
        >
          {[...groups].map(([group, options]) => (
            <optgroup key={group} label={group}>
              {options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <ChevronIcon />
      </label>
      {props.reasoning && (
        <label
          className="composer-select reasoning"
          title={
            props.reasoning.error ??
            (props.reasoning.supported
              ? '当前对话的思考强度'
              : '当前模型不支持调整思考强度')
          }
        >
          <Select
            aria-label="对话思考强度"
            value={props.reasoning.value ?? ''}
            disabled={props.reasoning.loading || !props.reasoning.supported}
            onValueChange={(value) =>
              props.reasoning?.onChange(
                value === '' ? null : (value as ReasoningEffort),
              )
            }
          >
            <option value="">
              {props.reasoning.loading
                ? '加载中'
                : props.reasoning.error
                  ? '加载失败'
                  : !props.reasoning.supported
                    ? '自动（不支持调整）'
                    : '自动'}
            </option>
            <option value="low">思考：低</option>
            <option value="medium">思考：中</option>
            <option value="high">思考：高</option>
          </Select>
        </label>
      )}
    </>
  )
}
