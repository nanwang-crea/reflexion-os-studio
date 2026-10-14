import { useState } from 'react'
import type {
  AgentTemplateSaveParams,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../components/forms/Select'
import { RoleModelField } from './RoleModelField'
import { PERMISSION_PRESET_LABELS } from '../../../hooks/permissions/usePermissionPreset'

export type RoleDraft = Omit<AgentTemplateSaveParams, 'requestId'>
export const emptyRole: RoleDraft = {
  name: '',
  description: '',
  systemPrompt: '',
  enabled: true,
  domains: [],
  projectId: null,
  modelBinding: { mode: 'inherit' },
  permissionCeiling: 'workspace-read',
  canDelegate: false,
  allowedTools: [
    'get_current_time',
    'web.fetch',
    'skill.use',
    'file.read',
    'file.list',
    'file.glob',
    'file.grep',
  ],
}

export function RoleEditor({
  value,
  onChange,
  profiles,
  projects,
  busy,
  onSave,
  onCancel,
}: {
  value: RoleDraft
  onChange: (draft: RoleDraft) => void
  profiles: ProviderProfile[]
  projects: Project[]
  busy: boolean
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [domainsText, setDomainsText] = useState(
    (value.domains ?? []).join(', '),
  )
  const [toolsText, setToolsText] = useState(value.allowedTools.join(', '))
  return (
    <form
      className="agent-role-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <h2>{value.id ? '编辑角色' : '新建角色'}</h2>
      <fieldset disabled={busy}>
        <label>
          角色名称
          <input
            required
            maxLength={80}
            value={value.name}
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
          />
        </label>
        <label>
          职责与适用场景
          <input
            required
            maxLength={500}
            value={value.description}
            onChange={(event) =>
              onChange({ ...value, description: event.target.value })
            }
          />
        </label>
        <label>
          领域分类
          <input
            placeholder="开发, 写作, 研究（逗号分隔，可多选）"
            value={domainsText}
            onChange={(event) => {
              setDomainsText(event.target.value)
              onChange({
                ...value,
                domains: event.target.value
                  .split(/[,，]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }}
          />
        </label>
        <label>
          作用范围
          <Select
            value={value.projectId ?? ''}
            onValueChange={(id) =>
              onChange({ ...value, projectId: id || null })
            }
          >
            <option value="">全局 · 所有项目可用</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </label>
        <RoleModelField
          value={value.modelBinding ?? { mode: 'inherit' }}
          profiles={profiles}
          onChange={(modelBinding) => onChange({ ...value, modelBinding })}
        />
        <label>
          角色指令
          <textarea
            required
            rows={9}
            maxLength={20000}
            value={value.systemPrompt}
            onChange={(event) =>
              onChange({ ...value, systemPrompt: event.target.value })
            }
          />
        </label>
        <label>
          权限上限
          <Select
            value={value.permissionCeiling ?? 'workspace-read'}
            onValueChange={(permissionCeiling) =>
              onChange({
                ...value,
                permissionCeiling:
                  permissionCeiling as RoleDraft['permissionCeiling'],
              })
            }
          >
            {Object.entries(PERMISSION_PRESET_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          允许工具
          <input
            value={toolsText}
            onChange={(event) => {
              setToolsText(event.target.value)
              onChange({
                ...value,
                allowedTools: event.target.value
                  .split(/[,，]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }}
          />
        </label>
        <small>
          工具和权限与父任务取交集。实例使用当前项目目录；分类不会改变文件访问范围。
        </small>
        <label className="agent-checkbox">
          <input
            type="checkbox"
            checked={value.canDelegate}
            onChange={(event) => {
              const tools = event.target.checked
                ? [...new Set([...value.allowedTools, 'task'])]
                : value.allowedTools.filter((tool) => tool !== 'task')
              setToolsText(tools.join(', '))
              onChange({
                ...value,
                canDelegate: event.target.checked,
                allowedTools: event.target.checked
                  ? [...new Set([...value.allowedTools, 'task'])]
                  : value.allowedTools.filter((tool) => tool !== 'task'),
              })
            }}
          />
          允许继续委派
        </label>
        <label className="agent-checkbox">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) =>
              onChange({ ...value, enabled: event.target.checked })
            }
          />
          启用角色
        </label>
      </fieldset>
      <footer>
        <button
          type="submit"
          disabled={busy || !value.name.trim() || !value.systemPrompt.trim()}
        >
          {busy ? '保存中…' : '保存角色'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </footer>
    </form>
  )
}
