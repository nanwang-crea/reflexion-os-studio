import { useMemo, useState } from 'react'
import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import { SessionRow } from './SessionRow'
import { ProjectFiles } from '../features/workspace/ProjectFiles'
import {
  ArchiveIcon,
  BoxIcon,
  FolderIcon,
  GearIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
  TrashIcon,
} from '../ui/icons'

export type AppView =
  'chat' | 'settings' | 'memories' | 'skills' | 'automations'

/** 底部导航可打开的页面（chat 由会话行/新建入口进入，不进底部导航）。 */
type OtherView = Exclude<AppView, 'chat'>

interface SidebarProps {
  /** 收起时仍保持挂载（保留搜索过滤等状态），仅隐藏。 */
  open: boolean
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

/** Codex 式时间分组：今天 / 昨天 / 7 天内 / 30 天内 / 更早。 */
function timeBucket(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '更早'
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const day = 24 * 60 * 60 * 1000
  const age = startOfToday.getTime() - time
  if (time >= startOfToday.getTime()) return '今天'
  if (age <= day) return '昨天'
  if (age <= 7 * day) return '7 天内'
  if (age <= 30 * day) return '30 天内'
  return '更早'
}

const BUCKET_ORDER = ['今天', '昨天', '7 天内', '30 天内', '更早']

function groupByTime(sessions: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    const bucket = timeBucket(session.updatedAt)
    const list = groups.get(bucket) ?? []
    list.push(session)
    groups.set(bucket, list)
  }
  return BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => [
    bucket,
    groups.get(bucket) as Session[],
  ])
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
          activePath={props.activeFilePath}
          focusAssetId={props.focusAssetId}
          onFocusConsumed={props.onFocusConsumed}
          onOpenFile={props.onOpenFile}
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
          label="自动化"
          icon={<BoxIcon size={15} />}
          active={props.view === 'automations'}
          onClick={() => props.onSelectView('automations')}
        />
        <NavItem
          label="记忆"
          icon={<ArchiveIcon size={15} />}
          active={props.view === 'memories'}
          onClick={() => props.onSelectView('memories')}
        />
      </nav>

      <ChatsPanel
        projects={props.projects}
        projectSessions={props.projectSessions}
        standaloneSessions={props.standaloneSessions}
        activeProjectId={props.activeProjectId}
        activeSessionId={props.activeSessionId}
        creatingProject={props.creatingProject}
        onSelectProject={props.onSelectProject}
        onSelectSession={props.onSelectSession}
        onSelectStandaloneSession={props.onSelectStandaloneSession}
        onNewSessionInProject={props.onNewSessionInProject}
        onEnterProjectFiles={props.onEnterProjectFiles}
        onCreateProject={props.onCreateProject}
        onDeleteProject={props.onDeleteProject}
        onRenameSession={props.onRenameSession}
        onDeleteSession={props.onDeleteSession}
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

interface ChatsPanelProps {
  projects: Project[]
  projectSessions: Session[]
  standaloneSessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  creatingProject: boolean
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onSelectStandaloneSession: (sessionId: string) => void
  onNewSessionInProject: (projectId: string) => void
  /** 点击项目行文件图标：切到该项目并让侧栏进入文件工作区。 */
  onEnterProjectFiles: (projectId: string) => void
  onCreateProject: () => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
}

/** 侧栏主体：过滤框 + 项目折叠区 + 独立会话时间分组。 */
function ChatsPanel(props: ChatsPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const keyword = filter.trim().toLowerCase()
  const projects = useMemo(() => {
    const match = (text: string): boolean =>
      keyword === '' || text.toLowerCase().includes(keyword)
    return props.projects.filter((project) => match(project.name))
  }, [props.projects, keyword])
  const standalone = useMemo(() => {
    const match = (text: string): boolean =>
      keyword === '' || text.toLowerCase().includes(keyword)
    return props.standaloneSessions.filter((session) => match(session.title))
  }, [props.standaloneSessions, keyword])

  return (
    <div className="chats-panel">
      <div className="panel-search">
        <SearchIcon size={13} />
        <input
          type="text"
          placeholder="搜索项目与会话"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="panel-scroll">
        <div className="section-head">
          <span>项目</span>
          <button
            className="icon-btn"
            title="新建项目：选择本地文件夹"
            aria-label="新建项目"
            disabled={props.creatingProject}
            onClick={() => void props.onCreateProject()}
          >
            <PlusIcon />
          </button>
        </div>
        <ul className="section-list">
          {projects.map((project) => {
            const active = project.id === props.activeProjectId
            return (
              <li key={project.id}>
                <div className={`project-row${active ? ' active' : ''}`}>
                  <button
                    className="row project-select"
                    title={project.folderPath || '未关联文件夹'}
                    onClick={() => props.onSelectProject(project.id)}
                  >
                    <span className="row-label">{project.name}</span>
                  </button>
                  <button
                    className="row-action"
                    title="打开项目文件工作区"
                    aria-label={`打开 ${project.name} 的文件`}
                    onClick={() => props.onEnterProjectFiles(project.id)}
                  >
                    <FolderIcon />
                  </button>
                  <button
                    className="row-action"
                    title="在该项目中新建会话"
                    aria-label={`在 ${project.name} 中新建会话`}
                    onClick={() => props.onNewSessionInProject(project.id)}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    className="row-action danger"
                    title="删除项目（其下会话一并删除）"
                    aria-label={`删除项目 ${project.name}`}
                    onClick={() => void props.onDeleteProject(project.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {active && (
                  <ul className="nested-list">
                    {props.projectSessions.map((session) => (
                      <li key={session.id}>
                        <SessionRow
                          session={session}
                          active={session.id === props.activeSessionId}
                          onSelect={() => props.onSelectSession(session.id)}
                          onRename={(title) =>
                            props.onRenameSession(session.id, title)
                          }
                          onDelete={() => props.onDeleteSession(session.id)}
                        />
                      </li>
                    ))}
                    {props.projectSessions.length === 0 && (
                      <li className="empty">在右侧输入，开始项目内会话</li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
          {projects.length === 0 && (
            <li className="empty">
              {keyword === '' ? '点击“＋”选择本地文件夹创建项目' : '无匹配项目'}
            </li>
          )}
        </ul>

        <div className="section-head">
          <span>对话</span>
        </div>
        {standalone.length === 0 && (
          <p className="empty">
            {keyword === '' ? '点上方“+”开始一段独立对话' : '无匹配会话'}
          </p>
        )}
        {groupByTime(standalone).map(([bucket, sessions]) => (
          <div key={bucket} className="time-group">
            <div className="time-group-label">{bucket}</div>
            <ul className="section-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <SessionRow
                    session={session}
                    active={session.id === props.activeSessionId}
                    onSelect={() => props.onSelectStandaloneSession(session.id)}
                    onRename={(title) =>
                      props.onRenameSession(session.id, title)
                    }
                    onDelete={() => props.onDeleteSession(session.id)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
