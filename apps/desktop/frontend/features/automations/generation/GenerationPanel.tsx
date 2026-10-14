import { useState } from 'react'
import {
  WorkflowDefinitionSchema,
  type WorkflowGeneration,
  type WorkflowDefinition,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import { WorkflowCanvas } from '../editor/WorkflowCanvas'
import { JsonField } from '../editor/JsonField'

export function GenerationPanel({
  value,
  disabled,
  canApply,
  onGenerate,
  onCancel,
  onApply,
  onEdit,
}: {
  value: WorkflowGeneration | null
  disabled: boolean
  canApply: boolean
  onGenerate: (mode: WorkflowGeneration['mode'], description: string) => void
  onCancel: () => void
  onApply: () => void
  onEdit: (definition: WorkflowDefinition) => void | Promise<void>
}): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<WorkflowGeneration['mode']>('graph')
  return (
    <section className="workflow-generation">
      <h3>自然语言生成</h3>
      <label>
        生成范围
        <Select
          value={mode}
          disabled={disabled || value?.status === 'running'}
          onValueChange={(value) =>
            setMode(value as WorkflowGeneration['mode'])
          }
        >
          <option value="graph">完整新流程</option>
          <option value="node">添加一个节点</option>
        </Select>
      </label>
      <label>
        描述
        <textarea
          rows={3}
          maxLength={8000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="例如：产品经理 → 设计师与测试计划并行 → 开发者 → 测试者 → 人工验收"
        />
      </label>
      <button
        type="button"
        disabled={
          disabled || !description.trim() || value?.status === 'running'
        }
        onClick={() => onGenerate(mode, description)}
      >
        生成候选
      </button>
      {value && (
        <>
          <p>
            {value.status} · tokens {value.tokensUsed}
            {value.tokensEstimated ? '（含估算）' : ''}
          </p>
          {value.status === 'running' && (
            <button type="button" onClick={onCancel}>
              取消生成
            </button>
          )}
          {value.errorCode && <p role="alert">{value.errorCode}</p>}
          {value.validation?.issues.map((issue, index) => (
            <p key={index}>
              {issue.path}：{issue.message}
            </p>
          ))}
          {value.candidate && (
            <>
              <WorkflowCanvas
                definition={value.candidate}
                readOnly
                onChange={() => {}}
                onSelect={() => {}}
                onError={() => {}}
              />
              <details>
                <summary>审阅角色、任务、工具、端口与预算</summary>
                <pre>{JSON.stringify(value.candidate, null, 2)}</pre>
              </details>
              {['ready', 'invalid'].includes(value.status) && (
                <fieldset disabled={disabled}>
                  <details>
                    <summary>编辑候选并重新校验</summary>
                    <JsonField
                      key={value.id}
                      label="候选定义 JSON"
                      value={value.candidate}
                      onApply={(raw) =>
                        onEdit(WorkflowDefinitionSchema.parse(raw))
                      }
                    />
                  </details>
                </fieldset>
              )}
              <button
                type="button"
                disabled={!canApply || value.status !== 'ready'}
                onClick={onApply}
              >
                应用到草稿
              </button>
              <p>应用后可编辑；保存版本与运行需要分别点击。</p>
            </>
          )}
        </>
      )}
    </section>
  )
}
