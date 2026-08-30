import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import { BoxIcon, PlusIcon } from '../../ui/icons'

interface ProviderListProps {
  profiles: ProviderProfile[]
  /** 当前选中的 key：供应商 id 或 'new'（新建草稿）。 */
  selectedKey: string | null
  onSelect: (key: string) => void
  creating: boolean
  onCreate: () => void
}

/** 模型设置页左栏：供应商列表 + 添加入口。 */
export function ProviderList(props: ProviderListProps): React.JSX.Element {
  return (
    <aside className="provider-list">
      <ul>
        {props.profiles.map((profile) => (
          <li key={profile.id}>
            <button
              className={`provider-item${
                profile.id === props.selectedKey && props.selectedKey !== 'new'
                  ? ' active'
                  : ''
              }`}
              onClick={() => props.onSelect(profile.id)}
            >
              <BoxIcon />
              <span className="row-label">{profile.name}</span>
              <span className={`status-dot${profile.enabled ? ' on' : ''}`} />
            </button>
          </li>
        ))}
        {props.profiles.length === 0 && <li className="empty">还没有供应商</li>}
      </ul>
      <button
        className="provider-add"
        onClick={() => props.onCreate()}
        disabled={props.creating}
      >
        <PlusIcon />
        添加供应商
      </button>
    </aside>
  )
}
