import { useState } from 'react'
import {
  ROLE_TOOL_GROUPS,
  ROLE_BUILTIN_TOOLS,
  ROLE_TOOL_PRESETS,
  setToolGroup,
  applyToolPreset,
} from './tool-selection'

export function RoleToolPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (tools: string[]) => void
}): React.JSX.Element {
  const [custom, setCustom] = useState('')
  const extras = value.filter(
    (tool) => !ROLE_BUILTIN_TOOLS.includes(tool) && tool !== 'task',
  )
  return (
    <div className="role-tool-picker">
      <div className="role-section-heading">
        <h4>工具能力</h4>
        <span>已选 {value.filter((tool) => tool !== 'task').length} 项</span>
      </div>
      <div className="role-quick-actions" aria-label="常用工具组合">
        {ROLE_TOOL_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(applyToolPreset(value, preset.tools))}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange(setToolGroup(value, ROLE_BUILTIN_TOOLS, true))
          }
        >
          全选内置工具
        </button>
        <button
          type="button"
          onClick={() =>
            onChange(setToolGroup(value, ROLE_BUILTIN_TOOLS, false))
          }
        >
          清空内置工具
        </button>
      </div>
      <small>
        组合只调整内置工具，不改变审批档位、MCP 工具和继续委派设置。
      </small>
      {ROLE_TOOL_GROUPS.map((group) => {
        const ids = group.tools.map(([id]) => id)
        const count = ids.filter((id) => value.includes(id)).length
        const all = count === ids.length
        return (
          <fieldset className="role-tool-group" key={group.id}>
            <legend>
              {group.title} · {count}/{ids.length}
            </legend>
            <button
              type="button"
              className="role-group-toggle"
              aria-label={`${all ? '取消' : '选择'}全部${group.title}`}
              onClick={() => onChange(setToolGroup(value, ids, !all))}
            >
              {all ? '取消整组' : '选择整组'}
            </button>
            <div className="role-tool-options">
              {group.tools.map(([id, label]) => (
                <label className="agent-checkbox" key={id} title={id}>
                  <input
                    type="checkbox"
                    checked={value.includes(id)}
                    onChange={(event) =>
                      onChange(setToolGroup(value, [id], event.target.checked))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        )
      })}
      <details className="role-custom-tools">
        <summary>其他工具与 MCP（{extras.length}）</summary>
        <small>
          保留已有工具标识；能否执行仍取决于上级任务是否开放该工具。
        </small>
        {extras.map((tool) => (
          <div className="role-custom-tool" key={tool}>
            <code>{tool}</code>
            <button
              type="button"
              aria-label={`移除工具 ${tool}`}
              onClick={() => onChange(value.filter((item) => item !== tool))}
            >
              移除
            </button>
          </div>
        ))}
        <label>
          添加工具标识
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="serverId/toolName，多个用逗号分隔"
          />
        </label>
        <button
          type="button"
          disabled={!custom.trim()}
          onClick={() => {
            const tools = custom
              .split(/[,，\n]/)
              .map((tool) => tool.trim())
              .filter((tool) => tool && tool !== 'task')
            onChange([...new Set([...value, ...tools])])
            setCustom('')
          }}
        >
          添加工具
        </button>
      </details>
    </div>
  )
}
