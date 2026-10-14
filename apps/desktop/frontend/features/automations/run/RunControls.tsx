import { useState } from 'react'
import {
  WorkflowValuesSchema,
  type ProviderProfile,
  type WorkflowDefinition,
  type PermissionPreset,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import type { WorkflowCommandParams } from '@reflexion-os-studio/contracts'

export function RunControls({
  providers,
  definition,
  disabled,
  modelKey,
  onModel,
  onStart,
}: {
  providers: ProviderProfile[]
  definition: WorkflowDefinition
  disabled: boolean
  modelKey: string
  onModel: (key: string) => void
  onStart: (
    input: Pick<
      WorkflowCommandParams<'workflow.run.start'>,
      'inputs' | 'defaultModel' | 'permissionPreset' | 'approvalOverride'
    >,
  ) => void
}): React.JSX.Element {
  const [inputs, setInputs] = useState('{}')
  const [preset, setPreset] = useState<PermissionPreset>('workspace-read')
  const [ask, setAsk] = useState(true)
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="workflow-run-controls">
      <h3>运行已保存版本</h3>
      <label>
        默认语言模型
        <Select value={modelKey} onValueChange={onModel}>
          <option value="">请选择</option>
          {providers
            .filter(
              (profile) =>
                profile.enabled && profile.capabilities.includes('chat'),
            )
            .flatMap((profile) =>
              profile.models.map((model) => (
                <option
                  key={`${profile.id}/${model}`}
                  value={JSON.stringify([profile.id, model])}
                >
                  {profile.name} / {model}
                </option>
              )),
            )}
        </Select>
      </label>
      <details>
        <summary>权限与审批</summary>
        <label>
          权限档位
          <Select
            value={preset}
            onValueChange={(value) => setPreset(value as PermissionPreset)}
          >
            <option value="workspace-read">工作区只读</option>
            <option value="workspace-write">工作区读写</option>
            <option value="workspace-full">工作区完整权限</option>
          </Select>
        </label>
        <label className="workflow-checkbox">
          <input
            type="checkbox"
            checked={ask}
            onChange={(event) => setAsk(event.target.checked)}
          />
          每次工具调用都询问
        </label>
      </details>
      <details>
        <summary>输入端口契约</summary>
        <pre>{JSON.stringify(definition.inputs, null, 2)}</pre>
      </details>
      <label>
        运行输入 JSON
        <textarea
          rows={5}
          value={inputs}
          spellCheck={false}
          onChange={(event) => setInputs(event.target.value)}
          placeholder={'{"text":{"type":"text","value":"任务描述"}}'}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={disabled || !modelKey}
        onClick={() => {
          try {
            const [providerId, model] = JSON.parse(modelKey) as [string, string]
            const values = WorkflowValuesSchema.parse(JSON.parse(inputs))
            setError(null)
            onStart({
              inputs: values,
              defaultModel: { mode: 'explicit', providerId, model },
              permissionPreset: preset,
              approvalOverride: ask ? 'ask-everything' : 'default',
            })
          } catch {
            setError('运行输入必须是符合端口契约的 WorkflowValues JSON')
          }
        }}
      >
        运行
      </button>
    </section>
  )
}
