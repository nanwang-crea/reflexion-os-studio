import { useEffect, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { BoxIcon, DoubleChevronIcon, GearIcon, SparkIcon } from '../../ui/icons'
import { AgentRuntimePanel } from './AgentRuntimePanel'
import { McpPanel } from './McpPanel'
import { ProviderEditor } from './ProviderEditor'
import { ProviderList } from './ProviderList'

type SettingsSection = 'models' | 'runtime' | 'mcp'

const SECTIONS: {
  id: SettingsSection
  label: string
  icon: React.ReactNode
}[] = [
  {
    id: 'models',
    label: '模型供应商',
    icon: <GearIcon size={15} />,
  },
  {
    id: 'runtime',
    label: 'Agent 运行时',
    icon: <SparkIcon size={15} />,
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    icon: <BoxIcon size={15} />,
  },
]

interface SettingsViewProps {
  profiles: ProviderProfile[]
  onSaved: () => Promise<void>
  onBackToChat: () => void
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}

/** 设置页：可折叠左侧导航 + 右侧内容区；顶部压缩头部。 */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('models')
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.profiles[0]?.id ?? null,
  )
  const [navCollapsed, setNavCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('settingsNavCollapsed') === 'true'
    }
    return false
  })

  const selected = selectedKey
    ? (props.profiles.find((profile) => profile.id === selectedKey) ?? null)
    : null

  useEffect(() => {
    if (selectedKey === 'new') return
    if (selectedKey === null) {
      if (props.profiles.length > 0) setSelectedKey(props.profiles[0].id)
      return
    }
    if (!props.profiles.some((profile) => profile.id === selectedKey)) {
      setSelectedKey(props.profiles[0]?.id ?? null)
    }
  }, [props.profiles, selectedKey])

  useEffect(() => {
    localStorage.setItem('settingsNavCollapsed', String(navCollapsed))
  }, [navCollapsed])

  const toggleNav = () => setNavCollapsed((prev) => !prev)

  return (
    <div className="settings-view">
      <header className="settings-head">
        <button
          type="button"
          className="ghost back-to-chat"
          onClick={props.onBackToChat}
        >
          <span className="back-arrow" aria-hidden>
            ←
          </span>
          返回对话
        </button>
        <h2>设置</h2>
      </header>

      <div className="settings-layout">
        <nav
          className={`settings-nav${navCollapsed ? ' collapsed' : ''}`}
          aria-label="设置分类"
        >
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-nav-item${
                section === entry.id ? ' active' : ''
              }`}
              onClick={() => setSection(entry.id)}
              title={navCollapsed ? entry.label : undefined}
            >
              {entry.icon}
              {!navCollapsed && (
                <span className="settings-nav-label">{entry.label}</span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="settings-nav-toggle"
            onClick={toggleNav}
            aria-label={navCollapsed ? '展开导航' : '折叠导航'}
            aria-expanded={!navCollapsed}
          >
            <DoubleChevronIcon
              size={14}
              direction={navCollapsed ? 'right' : 'left'}
            />
          </button>
        </nav>

        <div className="settings-content">
          {section === 'models' && (
            <>
              <div className="settings-panel-head">
                <h3 className="settings-panel-title">模型供应商</h3>
                <p className="hint">
                  管理自定义模型供应商，配置后可在聊天时选择使用。
                </p>
              </div>
              <div className="provider-manager">
                <ProviderList
                  profiles={props.profiles}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  creating={false}
                  onCreate={() => setSelectedKey('new')}
                />
                <section className="provider-detail">
                  <ProviderEditor
                    profile={selected}
                    isNew={selectedKey === 'new'}
                    profiles={props.profiles}
                    onSaved={props.onSaved}
                    onCreated={(id) => setSelectedKey(id)}
                    onDeleted={() => setSelectedKey(null)}
                  />
                </section>
              </div>
            </>
          )}
          {section === 'runtime' && (
            <div className="settings-panel">
              <div className="settings-panel-head">
                <h3 className="settings-panel-title">Agent 运行时</h3>
                <p className="hint">
                  调整循环、反思和网络请求参数；留空时使用推荐默认值。
                </p>
              </div>
              <AgentRuntimePanel />
            </div>
          )}
          {section === 'mcp' && (
            <div className="settings-panel">
              <div className="settings-panel-head">
                <h3 className="settings-panel-title">MCP 服务器</h3>
                <p className="hint">
                  连接外部 MCP server，其工具自动进入 Agent
                  工具集并在使用前请求审批。
                </p>
              </div>
              <McpPanel confirm={props.confirm} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
