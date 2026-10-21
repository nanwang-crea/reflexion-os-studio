import type {
  ReasoningEffort,
  ProviderModel,
} from '@reflexion-os-studio/runtime-client'
import { Select } from '../forms/Select'
import { GroupedSelect } from '../forms/GroupedSelect'

export interface ComposerModelOption {
  key: string
  label: string
  group: string
  reasoningUnavailableReason?: string
  reasoningEffortSupported?: boolean
  reasoningOptions?: ProviderModel['reasoningOptions']
  defaultReasoningEffort?: ReasoningEffort | null
}

export interface ReasoningSelection {
  value: ReasoningEffort | null
  options: ProviderModel['reasoningOptions']
  unavailableReason?: string
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
    <span className="composer-model-cluster">
      <span className="composer-select model" title="对话使用的模型">
        <GroupedSelect
          aria-label="对话模型"
          groups={groups}
          value={props.selectedKey}
          onValueChange={props.onModelChange}
        />
      </span>
      {props.reasoning && (
        <label
          className="composer-select reasoning"
          title={
            props.reasoning.error ??
            (props.reasoning.supported
              ? '当前对话的思考强度'
              : (props.reasoning.unavailableReason ??
                '当前模型不支持调整思考强度'))
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
                    ? `自动（${props.reasoning.unavailableReason ?? '不支持调整'}）`
                    : '服务端默认'}
            </option>
            {props.reasoning.options.map((option) => (
              <option key={option.value} value={option.value}>
                思考：{option.label}
              </option>
            ))}
          </Select>
        </label>
      )}
    </span>
  )
}
