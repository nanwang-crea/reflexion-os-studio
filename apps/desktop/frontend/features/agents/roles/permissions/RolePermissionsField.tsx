import { Select } from '../../../../components/forms/Select'
import {
  PERMISSION_PRESET_LABELS,
  PERMISSION_PRESET_HINTS,
} from '../../../../hooks/permissions/usePermissionPreset'
import type { RoleDraft } from '../RoleEditor'
import { RoleToolPicker } from './RoleToolPicker'

export function RolePermissionsField({
  value,
  onChange,
}: {
  value: RoleDraft
  onChange: (value: RoleDraft) => void
}): React.JSX.Element {
  const preset = value.permissionCeiling ?? 'workspace-read'
  return (
    <section className="role-editor-section" aria-label="执行权限">
      <h3>执行权限</h3>
      <label>
        审批档位上限
        <Select
          value={preset}
          onValueChange={(permissionCeiling) =>
            onChange({
              ...value,
              permissionCeiling:
                permissionCeiling as RoleDraft['permissionCeiling'],
            })
          }
        >
          {Object.entries(PERMISSION_PRESET_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
      </label>
      <small>{PERMISSION_PRESET_HINTS[preset]}</small>
      <p className="role-boundary-note">
        保存后，工具选择、审批档位上限与继续委派设置会应用于使用该角色的运行中任务。下一次模型请求和工具执行前读取最新权限；已经执行中的操作不会回滚。角色仍不能超出上级权限，执行目录来自当前任务的工作区。
      </p>
      <RoleToolPicker
        value={value.allowedTools}
        onChange={(allowedTools) => onChange({ ...value, allowedTools })}
      />
      <label className="agent-checkbox role-delegation-toggle">
        <input
          type="checkbox"
          checked={value.canDelegate}
          onChange={(event) =>
            onChange({
              ...value,
              canDelegate: event.target.checked,
              allowedTools: event.target.checked
                ? [...new Set([...value.allowedTools, 'task'])]
                : value.allowedTools.filter((tool) => tool !== 'task'),
            })
          }
        />
        允许继续委派给子 Agent
      </label>
      <small>还需上级允许委派，并受深度和数量预算限制。</small>
    </section>
  )
}
