import { useEffect, useState } from 'react'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { BoxIcon, GearIcon, SparkIcon } from '../../ui/icons'
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

/** 设置页：固定分类导航 + 单一内容列，保持各设置域的操作与状态独立。 */
export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('models')
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.profiles[0]?.id ?? null,
  )

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
        <div>
          <h2>设置</h2>
          <p>管理模型、Agent 行为与工具连接</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <span className="settings-nav-caption">设置</span>
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-nav-item${
                section === entry.id ? ' active' : ''
              }`}
              onClick={() => setSection(entry.id)}
            >
              {entry.icon}
              <span className="settings-nav-label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'models' && (
            <>
              <div className="settings-panel-head settings-page-heading">
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
                    confirm={props.confirm}
                  />
                </section>
              </div>
            </>
          )}
          {section === 'runtime' && (
            <div className="settings-panel">
              <div className="settings-panel-head settings-page-heading">
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
              <div className="settings-panel-head settings-page-heading">
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
