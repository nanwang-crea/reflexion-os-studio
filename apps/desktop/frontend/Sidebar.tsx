import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import { SessionRow } from './SessionRow'
import { FolderIcon, PlusIcon, TrashIcon } from './ui/icons'

interface SidebarProps {
  projects: Project[]
  /** 激活项目下的会话；仅当项目展开时展示。 */
  projectSessions: Session[]
  /** 不关联任何项目的独立会话。 */
  standaloneSessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  creatingProject: boolean
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onSelectStandaloneSession: (sessionId: string) => void
  /** 在指定项目内新建会话（进入项目落地页）。 */
  onNewSessionInProject: (projectId: string) => void
  onNewChat: () => void
  onCreateProject: () => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
}

/** ChatGPT 式时间分组：今天 / 昨天 / 7 天内 / 30 天内 / 更早。 */
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

export function Sidebar(props: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark" />
        <span className="brand-name">ReflexionOS Studio</span>
      </div>

      <div className="sidebar-scroll">
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
          {props.projects.map((project) => {
            const active = project.id === props.activeProjectId
            return (
              <li key={project.id}>
                <div className={`project-row${active ? ' active' : ''}`}>
                  <button
                    className="row project-select"
                    title={project.folderPath || '未关联文件夹'}
                    onClick={() => props.onSelectProject(project.id)}
                  >
                    <FolderIcon />
                    <span className="row-label">{project.name}</span>
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
          {props.projects.length === 0 && (
            <li className="empty">点击“＋”选择本地文件夹创建项目</li>
          )}
        </ul>

        <div className="section-head">
          <span>对话</span>
          <button
            className="icon-btn"
            title="新建独立对话"
            aria-label="新建独立对话"
            onClick={props.onNewChat}
          >
            <PlusIcon />
          </button>
        </div>
        {props.standaloneSessions.length === 0 && (
          <p className="empty">点击“＋”开始一段独立对话</p>
        )}
        {groupByTime(props.standaloneSessions).map(([bucket, sessions]) => (
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
    </aside>
  )
}
