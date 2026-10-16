import type { ViewName } from '../hooks/session/useSessionNavigation'
import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import { ChatsPanel } from './session/ChatsPanel'
import { ProjectFiles } from '../features/workspace/files/ProjectFiles'
import type { OpenDiffHandler } from '../features/workspace/types'
import {
  ArchiveIcon,
  BoxIcon,
  GearIcon,
  PlusIcon,
  SparkIcon,
} from '../ui/icons'

export type AppView = ViewName

/** 底部导航可打开的页面（chat 由会话行/新建入口进入，不进底部导航）。 */
type OtherView = Exclude<AppView, 'chat'>

interface SidebarProps {
  /** 收起时仍保持挂载（保留搜索过滤等状态），仅隐藏。 */
  open: boolean
  onImportChat?: (projectId: string | null) => void
  onExportChat?: (sessionId: string) => void
  archiveBusy?: boolean
  /** 侧栏可拖拽宽度。 */
  width: number
  /** 侧栏内容模式：chat=会话列表；files=当前项目文件工作区。 */
  mode: 'chat' | 'files'
  projects: Project[]
  /** 激活项目下的会话；仅当项目展开时展示。 */
  projectSessions: Session[]
  /** 不关联任何项目的独立会话。 */
  standaloneSessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  runningSessionIds?: string[]
  completedSessionIds?: string[]
  failedSessionIds?: string[]
  /** 有待审批工具调用的会话（显示 ✋ 标记，优先级最高）。 */
  approvalSessionIds?: string[]
  creatingProject: boolean
  /** 当前主视图；底部导航据此高亮。 */
  view: AppView
  /** Rust System Runtime 可用性：文件树/查看器依赖它。 */
  systemReady: boolean
  /** 右侧查看器当前激活文件；用于文件工作区高亮。 */
  activeFilePath: string | null
  /** 外部请求聚焦预览的 Asset（点击消息里的 asset:// 链接）。 */
  focusAssetId?: string | null
  onFocusConsumed?: () => void
  /** 点击文件：交给右侧查看器打开标签。 */
  onOpenFile: (path: string, line?: number) => void
  /** 点击 Git 变更/历史文件：在右侧查看器打开双栏 Diff。 */
  onOpenDiff?: OpenDiffHandler
  /** 切分支/pull 前的脏 buffer 三键守卫（透传给 Git 面板）；内部链，App 恒提供。 */
  guardDirtyBuffersThen: () => Promise<boolean>
  /** checkout/pull 成功后强制重载全部文本标签（透传给 Git 面板）。 */
  reloadAllTextTabs?: () => void
  /** 底部导航切换；点击已激活页回到聊天。 */
  onSelectView: (view: OtherView) => void
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onSelectStandaloneSession: (sessionId: string) => void
  /** 在指定项目内新建会话（进入项目落地页）。 */
  onNewSessionInProject: (projectId: string) => void
  /** 点击项目行文件图标：切到该项目并让侧栏进入文件工作区。 */
  onEnterProjectFiles: (projectId: string) => void
  /** 从文件工作区返回会话列表。 */
  onBackToChat: () => void
  onNewChat: () => void
  onCreateProject: () => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
}

/**
 * 桌面版 Codex 式单列侧栏：默认展示会话列表；切到文件模式后整个侧栏
 * 变为当前项目的文件工作区（文件 / Git 变更 / 资产 + 搜索 + 返回聊天）。
 */
export function Sidebar(props: SidebarProps): React.JSX.Element {
  const activeProject =
    props.projects.find((project) => project.id === props.activeProjectId) ??
    null

  // 文件模式：整个侧栏只展示当前项目的文件工作区，顶部提供返回聊天。
  if (props.mode === 'files') {
    return (
      <aside
        className={props.open ? 'sidebar' : 'sidebar sidebar-hidden'}
        aria-hidden={!props.open}
        style={{ width: props.width }}
      >
        <header className="sidebar-files-head">
          <button
            type="button"
            className="ghost sidebar-back"
            title="返回会话列表"
            aria-label="返回会话列表"
            onClick={props.onBackToChat}
          >
            ←
          </button>
          <span className="sidebar-files-brand">项目文件</span>
        </header>
        <ProjectFiles
          project={activeProject}
          systemReady={props.systemReady}
          activeSessionId={props.activeSessionId}
          activePath={props.activeFilePath}
          focusAssetId={props.focusAssetId}
          onFocusConsumed={props.onFocusConsumed}
          onOpenFile={props.onOpenFile}
          onOpenDiff={props.onOpenDiff}
          guardDirtyBuffersThen={props.guardDirtyBuffersThen}
          reloadAllTextTabs={props.reloadAllTextTabs}
        />
      </aside>
    )
  }

  return (
    <aside
      className={props.open ? 'sidebar' : 'sidebar sidebar-hidden'}
      aria-hidden={!props.open}
      style={{ width: props.width }}
    >
      <header className="sidebar-head">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <span className="brand-name">ReflexionOS</span>
      </header>
      <nav className="sidebar-nav" aria-label="页面导航">
        <NavItem
          label="新建对话"
          icon={<PlusIcon />}
          active={false}
          onClick={() => {
            if (props.activeProjectId) {
              props.onNewSessionInProject(props.activeProjectId)
            } else {
              props.onNewChat()
            }
          }}
        />
        <NavItem
          label="技能"
          icon={<SparkIcon size={15} />}
          active={props.view === 'skills'}
          onClick={() => props.onSelectView('skills')}
        />
        <NavItem
          label="Agent"
          icon={<BoxIcon size={15} />}
          active={props.view === 'agents'}
          onClick={() => props.onSelectView('agents')}
        />
        <NavItem
          label="指令"
          icon={<ArchiveIcon size={15} />}
          active={props.view === 'instructions'}
          onClick={() => props.onSelectView('instructions')}
        />
      </nav>

      <ChatsPanel
        projects={props.projects}
        projectSessions={props.projectSessions}
        standaloneSessions={props.standaloneSessions}
        activeProjectId={props.activeProjectId}
        activeSessionId={props.activeSessionId}
        runningSessionIds={props.runningSessionIds}
        completedSessionIds={props.completedSessionIds}
        failedSessionIds={props.failedSessionIds}
        approvalSessionIds={props.approvalSessionIds}
        creatingProject={props.creatingProject}
        onSelectProject={props.onSelectProject}
        onSelectSession={props.onSelectSession}
        onSelectStandaloneSession={props.onSelectStandaloneSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onEnterProjectFiles={props.onEnterProjectFiles}
        onCreateProject={props.onCreateProject}
        onNewChat={props.onNewChat}
        onDeleteProject={props.onDeleteProject}
        onRenameSession={props.onRenameSession}
        onDeleteSession={props.onDeleteSession}
        onImportChat={props.onImportChat}
        onExportChat={props.onExportChat}
        archiveBusy={props.archiveBusy}
      />

      <footer className="sidebar-footer">
        <NavItem
          label="设置"
          icon={<GearIcon size={15} />}
          active={props.view === 'settings'}
          onClick={() => props.onSelectView('settings')}
        />
      </footer>
    </aside>
  )
}

interface NavItemProps {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}

function NavItem(props: NavItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`nav-item${props.active ? ' active' : ''}`}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="nav-label">{props.label}</span>
    </button>
  )
}
