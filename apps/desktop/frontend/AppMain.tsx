import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { ViewName } from './hooks/useSessionNavigation'
import { TopBar } from './components/TopBar'
import { ChatView } from './features/chat/ChatView'
import { LandingView } from './features/landing/LandingView'
import { MemoryView } from './features/memories/MemoryView'
import { SkillsView } from './features/skills/SkillsView'
import { AutomationsView } from './features/automations/AutomationsView'
import { SettingsView } from './features/settings/SettingsView'
import { FileViewerPanel } from './features/workspace/FileViewerPanel'
import { TerminalPanel } from './features/terminal/TerminalPanel'
import { isTerminalEntryDisabled } from './features/terminal/entry-switch'
import { ResizeHandle } from './components/ResizeHandle'

export interface AppMainProps {
  view: ViewName
  activeSessionId: string | null
  /** TopBar 全部 props（contextTitle / 面板开关除外，本组件内推导）。 */
  topBar: Omit<
    ComponentProps<typeof TopBar>,
    | 'contextTitle'
    | 'showWorkspaceToggle'
    | 'workspaceOpen'
    | 'onToggleWorkspace'
    | 'showTerminalToggle'
    | 'terminalOpen'
    | 'onToggleTerminal'
  >
  notice: string | null
  onDismissNotice: () => void
  chat: ComponentProps<typeof ChatView>
  landing: ComponentProps<typeof LandingView>
  settings: ComponentProps<typeof SettingsView>
  memories: ComponentProps<typeof MemoryView>
  onUseSkill: ComponentProps<typeof SkillsView>['onUseSkill']
  workspace: {
    open: boolean
    setOpen: Dispatch<SetStateAction<boolean>>
    width: number
    setWidth: Dispatch<SetStateAction<number>>
    panel: ComponentProps<typeof FileViewerPanel>
  }
  terminal: {
    open: boolean
    onToggle: () => void
    activeProjectId: string | null
    confirm: ComponentProps<typeof FileViewerPanel>['confirm']
  }
}

/**
 * 主内容区：TopBar（标题按视图推导）+ 五视图分支（chat/landing/settings/
 * memories/skills/automations）+ chat 视图的右侧工作区面板。各分组 props
 * 用 ComponentProps 从视图组件派生，编译期约束、无平行类型。
 */
export function AppMain(props: AppMainProps): React.JSX.Element {
  const { view, activeSessionId, notice, workspace, terminal } = props
  const contextTitle =
    view === 'settings'
      ? '设置'
      : view === 'memories'
        ? '记忆'
        : view === 'skills'
          ? '技能'
          : view === 'automations'
            ? '自动化'
            : activeSessionId
              ? (props.chat.sessionData?.session?.title ?? '对话')
              : props.landing.project
                ? props.landing.project.name
                : '新对话'

  return (
    <div className="main-pane">
      <TopBar
        {...props.topBar}
        contextTitle={contextTitle}
        showWorkspaceToggle={view === 'chat'}
        workspaceOpen={workspace.open}
        onToggleWorkspace={() => workspace.setOpen((open) => !open)}
        showTerminalToggle={view === 'chat' && !isTerminalEntryDisabled()}
        terminalOpen={terminal.open}
        onToggleTerminal={terminal.onToggle}
      />
      {notice && (
        <div className="notice" role="alert" aria-live="assertive">
          <span>{notice}</span>
          <button
            type="button"
            className="ghost"
            onClick={props.onDismissNotice}
          >
            关闭
          </button>
        </div>
      )}
      <div className="content-area">
        <div className="content-main">
          {view === 'settings' ? (
            <SettingsView {...props.settings} />
          ) : view === 'memories' ? (
            <MemoryView {...props.memories} />
          ) : view === 'skills' ? (
            <SkillsView onUseSkill={props.onUseSkill} />
          ) : view === 'automations' ? (
            <AutomationsView />
          ) : activeSessionId !== null ? (
            <ChatView {...props.chat} />
          ) : (
            <LandingView {...props.landing} />
          )}
          {/* 底部终端面板：右侧文件查看器的下方对应物。实例保活在
              terminalManager（模块级单例），页面切换/收起只是容器回
              离屏宿主，不是销毁。 */}
          {view === 'chat' && terminal.open && (
            <TerminalPanel
              activeProjectId={terminal.activeProjectId}
              confirm={terminal.confirm}
            />
          )}
        </div>
        <div
          className="workspace-surface"
          style={{
            display: view === 'chat' && workspace.open ? 'contents' : 'none',
          }}
        >
          <ResizeHandle
            onResize={(delta) =>
              workspace.setWidth((width) =>
                Math.max(280, Math.min(900, width - delta)),
              )
            }
          />
          <FileViewerPanel {...workspace.panel} />
        </div>
      </div>
    </div>
  )
}
