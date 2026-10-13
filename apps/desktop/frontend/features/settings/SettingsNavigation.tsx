import { useState } from 'react'
import { BoxIcon, GearIcon, SearchIcon, SparkIcon } from '../../ui/icons'

const groups = [
  {
    label: '偏好设置',
    entries: [
      { id: 'appearance', label: '外观', icon: GearIcon },
      { id: 'browser', label: '浏览器', icon: BoxIcon },
    ],
  },
  {
    label: '模型与工具',
    entries: [
      { id: 'models', label: '模型供应商', icon: SparkIcon },
      { id: 'runtime', label: 'Agent 运行时', icon: GearIcon },
      { id: 'agent-browser', label: 'Agent 浏览器', icon: BoxIcon },
      { id: 'mcp', label: 'MCP 服务器', icon: BoxIcon },
    ],
  },
] as const

export type SettingsSection = (typeof groups)[number]['entries'][number]['id']

export function SettingsNavigation({
  section,
  onSelect,
  onBack,
}: {
  section: SettingsSection
  onSelect: (section: SettingsSection) => void
  onBack: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = groups.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) =>
      entry.label.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  }))
  return (
    <nav className="settings-nav" aria-label="设置分类">
      <div className="settings-nav-head">
        <button
          type="button"
          className="settings-back"
          onClick={onBack}
          aria-label="返回对话"
          title="返回对话"
        >
          <span aria-hidden="true">←</span>
        </button>
        <h2>设置</h2>
      </div>
      <label className="settings-search">
        <SearchIcon />
        <input
          type="search"
          aria-label="搜索设置分类"
          placeholder="搜索设置"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="settings-nav-groups">
        {filtered.map((group) =>
          group.entries.length > 0 ? (
            <div className="settings-nav-group" key={group.label}>
              <span className="settings-nav-caption">{group.label}</span>
              {group.entries.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`settings-nav-item${section === id ? ' active' : ''}`}
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => onSelect(id)}
                >
                  <Icon size={16} />
                  <span className="settings-nav-label">{label}</span>
                </button>
              ))}
            </div>
          ) : null,
        )}
        {filtered.every((group) => group.entries.length === 0) && (
          <p className="settings-search-empty" role="status">
            未找到匹配分类
          </p>
        )}
      </div>
    </nav>
  )
}
