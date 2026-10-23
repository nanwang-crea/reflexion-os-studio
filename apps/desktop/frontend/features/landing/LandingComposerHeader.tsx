import type { Project } from '@reflexion-os-studio/runtime-client'
import { Select } from '../../components/forms/Select'
import { FolderIcon, GearIcon } from '../../ui/icons'

export function LandingComposerHeader(props: {
  projects: Project[]
  selectedProjectId: string | null
  onProjectChange: (projectId: string | null) => void
  onGoSettings: () => void
}): React.JSX.Element {
  return (
    <div className="landing-composer-header">
      <span className="composer-select" title="新会话项目">
        <Select
          aria-label="新会话项目"
          icon={<FolderIcon />}
          value={props.selectedProjectId ?? ''}
          onValueChange={(value) => props.onProjectChange(value || null)}
        >
          <option value="">独立对话</option>
          {props.projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </span>
      <span className="landing-composer-device" title="任务在此计算机上运行">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 16V5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v11M3 16h18v4H3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        <span>此计算机</span>
      </span>
      <button
        type="button"
        className="landing-composer-settings"
        aria-label="打开设置"
        title="打开设置"
        onClick={props.onGoSettings}
      >
        <GearIcon size={18} />
      </button>
    </div>
  )
}
