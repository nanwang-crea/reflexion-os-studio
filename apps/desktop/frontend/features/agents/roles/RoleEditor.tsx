import type {
  AgentTemplateSaveParams,
  Project,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'
import { RoleModelField } from './RoleModelField'
import './role-editor.css'
import { RoleAvailabilityField } from './RoleAvailabilityField'
import { RolePermissionsField } from './permissions/RolePermissionsField'

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
  domains,
  busy,
  onSave,
  onCancel,
}: {
  value: RoleDraft
  onChange: (draft: RoleDraft) => void
  profiles: ProviderProfile[]
  projects: Project[]
  domains: string[]
  busy: boolean
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <form
      className="agent-role-editor"
      onSubmit={(event) => {
        event.preventDefault()
        if (
          (value.domains?.length ?? 0) <= 12 &&
          !value.domains?.some((domain) => domain.length > 40)
        )
          onSave()
      }}
    >
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
        <RoleAvailabilityField
          value={value}
          onChange={onChange}
          projects={projects}
          domains={domains}
        />
        <section className="role-editor-section" aria-label="模型与指令">
          <h3>模型与指令</h3>
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
        </section>
        <RolePermissionsField value={value} onChange={onChange} />
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
