import { useState } from 'react'
import type {
  AgentTemplate,
  AgentTemplateBulkUpdateParams,
  Project,
} from '@reflexion-os-studio/contracts'
import { Select } from '../../../../components/forms/Select'
import { RoleSidePanel } from '../RoleSidePanel'
import { PERMISSION_PRESET_LABELS } from '../../../../hooks/permissions/usePermissionPreset'
import { RoleToolPicker } from '../permissions/RoleToolPicker'
import { emptyRole } from '../RoleEditor'

type Patch = AgentTemplateBulkUpdateParams['patch']
export type BulkInput = Omit<AgentTemplateBulkUpdateParams, 'requestId'>

export function RoleBulkPanel({
  roles,
  projects,
  busy,
  error,
  onSave,
  onClose,
  onDirtyChange,
}: {
  roles: AgentTemplate[]
  projects: Project[]
  busy: boolean
  error: string | null
  onSave: (input: BulkInput) => Promise<boolean>
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const [changes, setChanges] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [permission, setPermission] =
    useState<NonNullable<Patch['permissionCeiling']>>('workspace-read')
  const [tools, setTools] = useState(emptyRole.allowedTools)
  const [delegate, setDelegate] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const toggle = (field: string) => {
    const next = changes.includes(field)
      ? changes.filter((item) => item !== field)
      : [...changes, field]
    setChanges(next)
    onDirtyChange(next.length > 0)
  }
  const option = (field: string, label: string) => (
    <label className="agent-checkbox">
      <input
        type="checkbox"
        checked={changes.includes(field)}
        onChange={() => toggle(field)}
      />
      {label}
    </label>
  )
  return (
    <RoleSidePanel
      title={`批量修改 ${roles.length} 个角色`}
      label="批量修改角色"
      busy={busy}
      onClose={onClose}
    >
      <form
        className="agent-role-editor"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy || !changes.length) return
          const patch: Patch = {}
          if (changes.includes('project')) patch.projectId = projectId || null
          if (changes.includes('permission'))
            patch.permissionCeiling = permission
          if (changes.includes('tools')) {
            patch.allowedTools = tools
            patch.canDelegate = delegate
          }
          if (changes.includes('enabled')) patch.enabled = enabled
          void onSave({
            targets: roles.map(({ id, updatedAt }) => ({ id, updatedAt })),
            patch,
          })
        }}
      >
        <p className="role-boundary-note">
          仅修改勾选的项目，其余配置保持各角色原值。所属项目决定角色在哪里可选，执行目录仍来自当前任务工作区。
        </p>
        <details>
          <summary>查看本次目标（{roles.length} 个，已固定）</summary>
          <p>{roles.map((role) => role.name).join('、')}</p>
        </details>
        <fieldset disabled={busy}>
          <section className="role-editor-section">
            {option('project', '修改所属项目 / 工作区')}
            {changes.includes('project') && (
              <label>
                统一可用位置
                <Select value={projectId} onValueChange={setProjectId}>
                  <option value="">全局 · 所有项目可选</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      仅项目 · {project.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </section>
          <section className="role-editor-section">
            {option('permission', '修改审批档位上限')}
            {changes.includes('permission') && (
              <label>
                统一审批档位
                <Select
                  value={permission}
                  onValueChange={(value) =>
                    setPermission(value as typeof permission)
                  }
                >
                  {Object.entries(PERMISSION_PRESET_LABELS).map(
                    ([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ),
                  )}
                </Select>
              </label>
            )}
          </section>
          <section className="role-editor-section">
            {option('tools', '统一工具能力与委派设置')}
            {changes.includes('tools') && (
              <>
                <p className="role-boundary-note">
                  将替换所选角色的工具清单（包含 MCP
                  工具）。实际能力仍受上级任务权限和逐次审批限制。
                </p>
                <RoleToolPicker value={tools} onChange={setTools} />
                <label className="agent-checkbox">
                  <input
                    type="checkbox"
                    checked={delegate}
                    onChange={(event) => setDelegate(event.target.checked)}
                  />
                  统一允许继续委派
                </label>
              </>
            )}
          </section>
          <section className="role-editor-section">
            {option('enabled', '修改启用状态')}
            {changes.includes('enabled') && (
              <label>
                统一启用状态
                <Select
                  value={enabled ? 'enabled' : 'disabled'}
                  onValueChange={(value) => setEnabled(value === 'enabled')}
                >
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </Select>
              </label>
            )}
          </section>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="submit" disabled={busy || !changes.length}>
            {busy ? '保存中…' : `应用到 ${roles.length} 个角色`}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
        </footer>
      </form>
    </RoleSidePanel>
  )
}
