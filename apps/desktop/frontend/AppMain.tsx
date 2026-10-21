import { useBrowserNavigationFailure } from './features/browser/useBrowserNavigationFailure'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BrowserSurfacePanel } from './features/browser/BrowserSurfacePanel'
import {
  useBrowserPanelState,
  setBrowserPanelOpen,
} from './features/browser/panel-state'
import type { ComponentProps, Dispatch, SetStateAction } from 'react'
import type { ViewName } from './hooks/session/useSessionNavigation'
import { TopBar } from './components/TopBar'
import { ChatView } from './features/chat/ChatView'
import { LandingView } from './features/landing/LandingView'
import { SkillsView } from './features/skills/SkillsView'
const AgentRolesView = lazy(async () => ({
  default: (await import('./features/agents/AgentRolesView')).AgentRolesView,
}))
const CollaborationPanel = lazy(async () => ({
  default: (await import('./features/chat/collaboration/CollaborationPanel'))
    .CollaborationPanel,
}))
import { InstructionsView } from './features/instructions/InstructionsView'
import { SettingsView } from './features/settings/SettingsView'
import { FileViewerPanel } from './features/workspace/files/FileViewerPanel'
import { TerminalPanel } from './features/terminal/TerminalPanel'
import { isTerminalEntryDisabled } from './features/terminal/entry-switch'
import { ResizeHandle } from './components/ResizeHandle'
import { SurfacePanelTabs } from './components/surfaces/SurfacePanelTabs'
import { tabIdOf } from './features/workspace/types'

export interface AppMainProps {
  view: ViewName
  activeSessionId: string | null
  /** TopBar 全部 props（contextTitle / 面板开关除外，本组件内推导）。 */
  topBar: Omit<
    ComponentProps<typeof TopBar>,
    | 'browserOpen'
    | 'onToggleBrowser'
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
  instructions: ComponentProps<typeof InstructionsView>
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
 * 主内容区：TopBar（标题按视图推导）+ 六视图分支（chat/landing/settings/
 * skills/agents/instructions）+ chat 视图的右侧工作区面板。各分组 props
 * 用 ComponentProps 从视图组件派生，编译期约束、无平行类型。
 */
export function AppMain(props: AppMainProps): React.JSX.Element {
  const { view, activeSessionId, notice, workspace, terminal } = props
  const navigation = useBrowserNavigationFailure(activeSessionId)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [browserWidth, setBrowserWidth] = useState<number | null>(null)
  const { open: browserOpen } = useBrowserPanelState()
  const [surfaceExpanded, setSurfaceExpanded] = useState(false)
  const fileNavigationNonce = workspace.panel.openTabs.find(
    (tab) => tabIdOf(tab) === workspace.panel.activeTabId,
  )?.nonce
  useEffect(() => {
    setBrowserPanelOpen(false)
    setCollaborationOpen(false)
  }, [workspace.panel.activeTabId, fileNavigationNonce, view])
  useEffect(() => {
    setSurfaceExpanded(false)
  }, [activeSessionId])
  const surfaceOpen =
    browserOpen || (view === 'chat' && (workspace.open || collaborationOpen))
  useEffect(() => {
    if (!surfaceOpen) setSurfaceExpanded(false)
  }, [surfaceOpen])
  const contextTitle =
    view === 'settings'
      ? '设置'
      : view === 'skills'
        ? '技能'
        : view === 'agents'
          ? 'Agent 角色'
          : view === 'instructions'
            ? '指令'
            : activeSessionId
              ? (props.chat.sessionData?.session?.title ?? '对话')
              : props.landing.project
                ? props.landing.project.name
                : '新对话'

  return (
    <div
      className={`main-pane surface-split-layout${surfaceExpanded ? ' surface-expanded' : ''}`}
    >
      <div
        className="main-chat-column"
        hidden={surfaceExpanded}
        inert={surfaceExpanded}
      >
        <TopBar
          {...props.topBar}
          collaborationOpen={collaborationOpen}
          onToggleCollaboration={
            view === 'chat'
              ? () => {
                  setCollaborationOpen((open) => !open)
                  workspace.setOpen(false)
                  setBrowserPanelOpen(false)
                }
              : undefined
          }
          contextTitle={contextTitle}
          browserOpen={browserOpen}
          onToggleBrowser={() => {
            setCollaborationOpen(false)
            setBrowserPanelOpen(!browserOpen)
          }}
          showWorkspaceToggle={view === 'chat'}
          workspaceOpen={workspace.open && !browserOpen && !collaborationOpen}
          onToggleWorkspace={() => {
            setCollaborationOpen(false)
            if (browserOpen) {
              setBrowserPanelOpen(false)
              workspace.setOpen(true)
            } else workspace.setOpen((open) => !open)
          }}
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
            ) : view === 'skills' ? (
              <SkillsView onUseSkill={props.onUseSkill} />
            ) : view === 'agents' ? (
              <Suspense fallback={<p>正在加载角色…</p>}>
                <AgentRolesView
                  profiles={props.settings.profiles}
                  initialProjectId={terminal.activeProjectId}
                  confirm={terminal.confirm}
                />
              </Suspense>
            ) : view === 'instructions' ? (
              <InstructionsView {...props.instructions} />
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
        </div>
      </div>
      <div
        ref={surfaceRef}
        className="right-surface"
        style={{
          display: surfaceOpen ? 'flex' : 'none',
          width: surfaceExpanded
            ? '100%'
            : browserOpen
              ? (browserWidth ?? '50%')
              : workspace.width,
        }}
      >
        <ResizeHandle
          resizeSide="next"
          onResize={(delta, width) => {
            const nextWidth = Math.max(
              360,
              Math.min(
                1200,
                (surfaceRef.current?.getBoundingClientRect().width ?? width) -
                  delta,
              ),
            )
            if (browserOpen) setBrowserWidth(nextWidth)
            else workspace.setWidth(nextWidth)
          }}
        />
        <div className="right-surface-content">
          <SurfacePanelTabs
            active={
              browserOpen
                ? 'browser'
                : collaborationOpen
                  ? 'collaboration'
                  : 'workspace'
            }
            showWorkspace={view === 'chat'}
            showCollaboration={view === 'chat'}
            expanded={surfaceExpanded}
            onToggleExpanded={() => setSurfaceExpanded((expanded) => !expanded)}
            onSelect={(surface) => {
              setCollaborationOpen(surface === 'collaboration')
              setBrowserPanelOpen(surface === 'browser')
              if (surface === 'workspace') workspace.setOpen(true)
            }}
            onCollapse={() => {
              setSurfaceExpanded(false)
              setBrowserPanelOpen(false)
              workspace.setOpen(false)
              setCollaborationOpen(false)
            }}
          />
          <div
            className="workspace-surface"
            style={{
              display:
                view === 'chat' && !browserOpen && !collaborationOpen
                  ? 'contents'
                  : 'none',
            }}
          >
            <FileViewerPanel {...workspace.panel} />
          </div>
          {view === 'chat' && collaborationOpen && (
            <Suspense fallback={<p>正在加载协作…</p>}>
              <CollaborationPanel
                key={activeSessionId ?? 'new'}
                chat={{
                  ...props.chat,
                  onResourceClick: (link) => {
                    props.chat.onResourceClick?.(link)
                    setCollaborationOpen(false)
                    workspace.setOpen(true)
                  },
                  onOpenDiff: (path, options) => {
                    props.chat.onOpenDiff?.(path, options)
                    setCollaborationOpen(false)
                    workspace.setOpen(true)
                  },
                }}
                onCollapse={() => {
                  setCollaborationOpen(false)
                  workspace.setOpen(false)
                }}
              />
            </Suspense>
          )}
          <div
            className="browser-panel-host"
            style={{ display: browserOpen ? 'flex' : 'none' }}
          >
            <BrowserSurfacePanel
              navigationFailure={navigation.failure}
              onDismissNavigationFailure={navigation.dismiss}
              visible={browserOpen}
              onWorkspace={() => {
                setCollaborationOpen(false)
                setBrowserPanelOpen(false)
                workspace.setOpen(true)
              }}
              onTerminal={() => {
                setSurfaceExpanded(false)
                if (!terminal.open) terminal.onToggle()
              }}
              onCollapse={() => {
                setBrowserPanelOpen(false)
                workspace.setOpen(false)
                setCollaborationOpen(false)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
