import { lazy, Suspense, useEffect, useState } from 'react'
import type { ComponentProps } from 'react'
import type { DeveloperView as DeveloperViewType } from '../developer/DeveloperView'
import type { ProviderProfile } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { SettingsNavigation, type SettingsSection } from './SettingsNavigation'
import { AgentRuntimePanel } from './AgentRuntimePanel'
import { McpPanel } from './McpPanel'
import { ProviderEditor } from './ProviderEditor'
import { ProviderList } from './ProviderList'
import { AppearancePanel } from './appearance/AppearancePanel'
import { AgentBrowserSettingsPanel } from './agent-browser/AgentBrowserSettingsPanel'
import { BrowserSettingsPanel } from '../../components/browser-settings/BrowserSettingsPanel'

const DeveloperView = lazy(async () => ({
  default: (await import('../developer/DeveloperView')).DeveloperView,
}))

interface SettingsViewProps {
  developer: ComponentProps<typeof DeveloperViewType>
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
      <div className="settings-layout">
        <SettingsNavigation
          section={section}
          onSelect={setSection}
          onBack={props.onBackToChat}
        />
        <div className="settings-content">
          <div className={`settings-content-inner settings-content-${section}`}>
            {section === 'appearance' && <AppearancePanel />}
            {section === 'browser' && <BrowserSettingsPanel />}
            {section === 'agent-browser' && <AgentBrowserSettingsPanel />}
            {section === 'developer' && (
              <Suspense fallback={<p>正在加载开发者页面…</p>}>
                <DeveloperView {...props.developer} />
              </Suspense>
            )}
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
                    管理运行预算、网络请求与子
                    Agent；可选上限支持默认、自定义或不限制。
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
    </div>
  )
}
