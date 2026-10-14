import { useState, type ReactNode } from 'react'
import {
  WorkflowDefinitionSchema,
  type WorkflowGeneration,
  type WorkflowDefinition,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import { WorkflowCanvas } from '../editor/WorkflowCanvas'
import { JsonField } from '../editor/JsonField'
import './generation.css'

export function GenerationPanel({
  value,
  disabled,
  canApply,
  onGenerate,
  onCancel,
  onApply,
  onEdit,
  modelPicker,
  onOpenCanvas,
}: {
  value: WorkflowGeneration | null
  disabled: boolean
  canApply: boolean
  onGenerate: (mode: WorkflowGeneration['mode'], description: string) => void
  onCancel: () => void
  onApply: () => void
  onEdit: (definition: WorkflowDefinition) => void | Promise<void>
  modelPicker?: ReactNode
  onOpenCanvas?: () => void
}): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<WorkflowGeneration['mode']>('graph')
  return (
    <section className="workflow-generation-main">
      <header>
        <span className="workflow-generation-eyebrow">从想法开始</span>
        <h2>描述任务，生成协作流程</h2>
        <p>告诉 AI 需要哪些角色、如何协作。生成后审阅画布，再调整和运行。</p>
      </header>
      <div className="workflow-generation-content">
        <div className="workflow-generation-compose">
          {modelPicker}
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
              <option value="node">向当前草稿添加节点</option>
            </Select>
          </label>
          <label>
            描述
            <textarea
              rows={8}
              maxLength={8000}
              value={description}
              readOnly={value?.status === 'running'}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="例如：做一个代码 Builder，由产品经理梳理需求，设计师和测试计划并行，再交给开发者和测试者，最后由我验收。"
            />
          </label>
          <button
            className="workflow-generation-submit"
            type="button"
            disabled={
              disabled || !description.trim() || value?.status === 'running'
            }
            onClick={() => onGenerate(mode, description)}
          >
            {value?.status === 'running'
              ? '正在生成…'
              : mode === 'graph'
                ? '生成工作流'
                : '生成并追加节点'}
          </button>
          {value?.status === 'running' && (
            <button type="button" onClick={onCancel}>
              取消生成
            </button>
          )}
          {value && (
            <p className="workflow-muted">
              {value.status} · tokens {value.tokensUsed}
              {value.tokensEstimated ? '（含估算）' : ''}
            </p>
          )}
          {value?.errorCode && <p role="alert">{value.errorCode}</p>}
          {value?.validation?.issues.map((issue, index) => (
            <p key={index}>
              {issue.path}：{issue.message}
            </p>
          ))}
        </div>
        <div className="workflow-generation-preview">
          {value?.candidate ? (
            <>
              <div className="workflow-generation-preview-head">
                <strong>{value.candidate.name}</strong>
                <span>{value.candidate.nodes.length} 个节点 · 候选预览</span>
              </div>
              <WorkflowCanvas
                definition={value.candidate}
                readOnly
                onChange={() => {}}
                onSelect={() => {}}
                onError={() => {}}
              />
              <div className="workflow-generation-review">
                <details>
                  <summary>审阅角色、任务与端口</summary>
                  <pre>{JSON.stringify(value.candidate, null, 2)}</pre>
                </details>
                {['ready', 'invalid'].includes(value.status) && (
                  <fieldset disabled={disabled}>
                    <details>
                      <summary>高级修改候选</summary>
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
                {value.status === 'applied' ? (
                  <button type="button" onClick={onOpenCanvas}>
                    在画布中继续编辑 →
                  </button>
                ) : (
                  <button
                    className="workflow-generation-submit"
                    type="button"
                    disabled={!canApply || value.status !== 'ready'}
                    onClick={onApply}
                  >
                    应用并编辑画布 →
                  </button>
                )}
                <p className="workflow-muted">
                  应用后可调整节点和连线；保存版本后点击运行，系统自动校验。
                </p>
              </div>
            </>
          ) : (
            <div className="workflow-generation-empty">
              <span aria-hidden="true">◇ → ◇ → ◇</span>
              <h3>
                {value?.status === 'running'
                  ? '正在构建协作流程'
                  : '你的协作画布会出现在这里'}
              </h3>
              <p>
                支持产品开发、写作编辑等流程，也可以为已有草稿追加角色节点。
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
