import { useState } from 'react'
import type { Project, Session } from '@reflexion-os-studio/runtime-client'

interface SidebarProps {
  projects: Project[]
  sessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
  onCreateProject: (name: string) => Promise<void>
  onCreateSession: (title?: string) => Promise<void>
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [newProjectName, setNewProjectName] = useState('')

  const submitProject = async (): Promise<void> => {
    const name = newProjectName.trim()
    if (!name) return
    setNewProjectName('')
    await props.onCreateProject(name)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">项目</div>
        <ul className="sidebar-list">
          {props.projects.map((project) => (
            <li key={project.id}>
              <button
                className={project.id === props.activeProjectId ? 'active' : ''}
                onClick={() => props.onSelectProject(project.id)}
              >
                {project.name}
              </button>
            </li>
          ))}
          {props.projects.length === 0 && <li className="empty">暂无项目</li>}
        </ul>
        <div className="sidebar-create">
          <input
            placeholder="新项目名称"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitProject()
            }}
          />
          <button
            disabled={!newProjectName.trim()}
            onClick={() => void submitProject()}
          >
            新建
          </button>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-title">会话</div>
        <ul className="sidebar-list">
          {props.sessions.map((session) => (
            <li key={session.id}>
              <button
                className={session.id === props.activeSessionId ? 'active' : ''}
                onClick={() => props.onSelectSession(session.id)}
              >
                {session.title}
              </button>
            </li>
          ))}
          {props.sessions.length === 0 && (
            <li className="empty">选择项目后创建会话</li>
          )}
        </ul>
        <button
          className="wide"
          disabled={!props.activeProjectId}
          onClick={() => void props.onCreateSession()}
        >
          新建会话
        </button>
      </div>
    </aside>
  )
}
