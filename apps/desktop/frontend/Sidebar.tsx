import type { Project, Session } from '@reflexion-os-studio/runtime-client'

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
  onSelectProjectSession: (sessionId: string) => void
  onSelectStandaloneSession: (sessionId: string) => void
  /** 在指定项目内新建会话（进入项目落地页）。 */
  onNewSessionInProject: (projectId: string) => void
  onNewChat: () => void
  onCreateProject: () => Promise<void>
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
        fill="currentColor"
      />
    </svg>
  )
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
                </div>
                {active && (
                  <ul className="nested-list">
                    {props.projectSessions.map((session) => (
                      <li key={session.id}>
                        <button
                          className={`row session-row${
                            session.id === props.activeSessionId
                              ? ' active'
                              : ''
                          }`}
                          title={session.title}
                          onClick={() =>
                            props.onSelectProjectSession(session.id)
                          }
                        >
                          <span className="row-label">{session.title}</span>
                        </button>
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
        <ul className="section-list">
          {props.standaloneSessions.map((session) => (
            <li key={session.id}>
              <button
                className={`row session-row${
                  session.id === props.activeSessionId ? ' active' : ''
                }`}
                title={session.title}
                onClick={() => props.onSelectStandaloneSession(session.id)}
              >
                <span className="row-label">{session.title}</span>
              </button>
            </li>
          ))}
          {props.standaloneSessions.length === 0 && (
            <li className="empty">点击“＋”开始一段独立对话</li>
          )}
        </ul>
      </div>
    </aside>
  )
}
