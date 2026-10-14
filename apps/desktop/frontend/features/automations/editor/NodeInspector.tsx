import {
  WorkflowNodeSchema,
  type WorkflowNode,
  type AgentTemplate,
  type ProviderProfile,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import { JsonField } from './JsonField'
const PortsSchema = WorkflowNodeSchema.options[0].pick({
  inputs: true,
  outputs: true,
})

export function NodeInspector({
  node,
  templates,
  providers,
  onChange,
}: {
  node: WorkflowNode
  templates: AgentTemplate[]
  providers: ProviderProfile[]
  onChange: (node: WorkflowNode) => void
}): React.JSX.Element {
  return (
    <section className="workflow-inspector">
      <h3>节点配置</h3>
      <label>
        名称
        <input
          value={node.name}
          onChange={(event) => onChange({ ...node, name: event.target.value })}
        />
      </label>
      {node.kind === 'agent' ? (
        <>
          <label>
            角色模板
            <Select
              value={node.role.templateId ?? ''}
              onValueChange={(id) => {
                const template = templates.find(
                  (template) => template.id === id,
                )
                onChange({
                  ...node,
                  role: template
                    ? {
                        templateId: template.id,
                        templateUpdatedAt: null,
                        name: template.name,
                        systemPrompt: template.systemPrompt,
                        policy: {
                          ...template.policy,
                          canDelegate: false,
                          allowedTools: template.policy.allowedTools.filter(
                            (tool) => !['task', 'ask_user'].includes(tool),
                          ),
                        },
                      }
                    : {
                        ...node.role,
                        templateId: null,
                        templateUpdatedAt: null,
                      },
                })
              }}
            >
              <option value="">自定义 Prompt</option>
              {templates
                .filter((template) => template.enabled)
                .map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            角色 Prompt
            <textarea
              rows={6}
              value={node.role.systemPrompt}
              disabled={node.role.templateId !== null}
              onChange={(event) =>
                onChange({
                  ...node,
                  role: { ...node.role, systemPrompt: event.target.value },
                })
              }
            />
          </label>
          <label>
            节点任务
            <textarea
              rows={5}
              value={node.taskPrompt}
              onChange={(event) =>
                onChange({ ...node, taskPrompt: event.target.value })
              }
            />
          </label>
          <label>
            模型
            <Select
              value={
                node.model.mode === 'default'
                  ? ''
                  : JSON.stringify([node.model.providerId, node.model.model])
              }
              onValueChange={(value) => {
                const pair = value
                  ? (JSON.parse(value) as [string, string])
                  : null
                onChange({
                  ...node,
                  model: pair
                    ? { mode: 'explicit', providerId: pair[0], model: pair[1] }
                    : { mode: 'default' },
                })
              }}
            >
              <option value="">继承运行时选择</option>
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
          <JsonField
            key={`${node.id}:policy:${node.role.templateId}`}
            label="权限与工具上限"
            value={node.role.policy}
            onApply={(value) =>
              onChange(
                WorkflowNodeSchema.parse({
                  ...node,
                  role: { ...node.role, policy: value },
                }),
              )
            }
          />
          <JsonField
            key={`${node.id}:budget`}
            label="节点预算"
            value={node.budget}
            onApply={(value) =>
              onChange(WorkflowNodeSchema.parse({ ...node, budget: value }))
            }
          />
        </>
      ) : (
        <label>
          验收说明
          <textarea
            rows={5}
            value={node.instruction}
            onChange={(event) =>
              onChange({ ...node, instruction: event.target.value })
            }
          />
        </label>
      )}
      <JsonField
        key={`${node.id}:ports`}
        label="输入输出端口"
        value={{ inputs: node.inputs, outputs: node.outputs }}
        onApply={(value) => {
          const ports = PortsSchema.parse(value)
          onChange(
            WorkflowNodeSchema.parse({
              ...node,
              ...ports,
            }),
          )
        }}
      />
    </section>
  )
}
