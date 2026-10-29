import { useMemo, useState } from 'react'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import type { Session } from '@reflexion-os-studio/runtime-client'

type Project = RemoteCatalog['projects'][number]

export function RemoteNavigation({
  projects,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onBrowseFiles,
  onRefresh,
  onClose,
}: {
  projects: Project[]
  sessions: Session[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateSession: (projectId: string | null) => void
  onBrowseFiles: (projectId: string) => void
  onRefresh: () => void
  onClose?: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(projects.map((project) => project.id)),
  )
  const grouped = useMemo(() => {
    const result = new Map<string, Session[]>()
    for (const session of sessions) {
      if (!session.projectId) continue
      const group = result.get(session.projectId) ?? []
      group.push(session)
      result.set(session.projectId, group)
    }
    return result
  }, [sessions])
  const matches = (value: string): boolean =>
    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const standalone = sessions.filter(
    (session) => !session.projectId && matches(session.title),
  )

  return (
    <aside className="remote-navigation" aria-label="会话导航">
      <header className="remote-nav-brand">
        <span className="brand-mark" aria-hidden="true">
          R
        </span>
        <strong>ReflexionOS</strong>
        {onClose && (
          <button className="ghost" onClick={onClose} aria-label="关闭导航">
            关闭
          </button>
        )}
      </header>
      <nav className="remote-nav-links" aria-label="导航">
        <button
          className="nav-item active"
          onClick={() => onCreateSession(null)}
        >
          ＋<span>新建对话</span>
        </button>
        <button className="nav-item" onClick={onRefresh}>
          ↻<span>刷新会话</span>
        </button>
      </nav>
      <label className="remote-nav-search">
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索项目与会话"
        />
      </label>
      <div className="remote-nav-scroll">
        <div className="remote-nav-section-title">
          <span>项目</span>
        </div>
        {projects
          .filter(
            (project) =>
              matches(project.name) ||
              (grouped.get(project.id) ?? []).some((session) =>
                matches(session.title),
              ),
          )
          .map((project) => {
            const open = expanded.has(project.id) || matches(project.name)
            const projectSessions = (grouped.get(project.id) ?? []).filter(
              (session) => matches(session.title),
            )
            return (
              <section className="remote-nav-project" key={project.id}>
                <div className="remote-nav-project-head">
                  <button
                    className="remote-nav-project-name"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })
                    }
                  >
                    <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                    {project.name}
                  </button>
                  <button
                    className="remote-nav-action"
                    aria-label={`浏览 ${project.name} 文件`}
                    onClick={() => {
                      onBrowseFiles(project.id)
                      onClose?.()
                    }}
                  >
                    ▱
                  </button>
                  <button
                    className="remote-nav-action"
                    aria-label={`在 ${project.name} 新建会话`}
                    onClick={() => onCreateSession(project.id)}
                  >
                    ＋
                  </button>
                </div>
                {open && (
                  <ul className="remote-nav-session-list">
                    {projectSessions.map((session) => (
                      <li key={session.id}>
                        <button
                          className={`remote-nav-session${session.id === activeSessionId ? ' active' : ''}`}
                          onClick={() => {
                            onSelectSession(session.id)
                            onClose?.()
                          }}
                        >
                          {session.title || '新会话'}
                        </button>
                      </li>
                    ))}
                    {projectSessions.length === 0 && (
                      <li className="remote-nav-empty">暂无会话</li>
                    )}
                  </ul>
                )}
              </section>
            )
          })}
        <div className="remote-nav-section-title">对话</div>
        <ul className="remote-nav-session-list">
          {standalone.map((session) => (
            <li key={session.id}>
              <button
                className={`remote-nav-session${session.id === activeSessionId ? ' active' : ''}`}
                onClick={() => {
                  onSelectSession(session.id)
                  onClose?.()
                }}
              >
                {session.title || '新会话'}
              </button>
            </li>
          ))}
          {standalone.length === 0 && (
            <li className="remote-nav-empty">暂无独立会话</li>
          )}
        </ul>
      </div>
      <footer className="remote-nav-footer">手机连接 · 此电脑</footer>
    </aside>
  )
}
