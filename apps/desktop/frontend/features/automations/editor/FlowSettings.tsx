import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@reflexion-os-studio/contracts'
import { JsonField } from './JsonField'

export function FlowSettings({
  value,
  documentKey,
  onChange,
}: {
  value: WorkflowDefinition
  documentKey: string
  onChange: (value: WorkflowDefinition) => void
}): React.JSX.Element {
  return (
    <>
      <label>
        工作流名称
        <input
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <label>
        说明
        <textarea
          rows={4}
          value={value.description}
          onChange={(event) =>
            onChange({ ...value, description: event.target.value })
          }
        />
      </label>
      <details>
        <summary>高级配置 · 端口、绑定与预算</summary>
        <JsonField
          key={documentKey}
          label="完整定义 JSON"
          value={value}
          onApply={(raw) => onChange(WorkflowDefinitionSchema.parse(raw))}
        />
      </details>
    </>
  )
}
