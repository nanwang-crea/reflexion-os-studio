import { useEffect, useMemo, useState } from 'react'
import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import { SessionRow } from '../SessionRow'
import { FolderIcon, PlusIcon, SearchIcon, TrashIcon } from '../../ui/icons'

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
/** 运行中的会话排前，保证侧栏可见性。 */
function sortByRunningFirst(
  sessions: Session[],
  runningSessionIds: string[] | undefined,
): Session[] {
  const running = new Set(runningSessionIds ?? [])
  return [...sessions].sort(
    (a, b) => Number(running.has(b.id)) - Number(running.has(a.id)),
  )
}

interface ChatsPanelProps {
  onImportChat?: (projectId: string | null) => void
  onExportChat?: (sessionId: string) => void
  archiveBusy?: boolean
  projects: Project[]
  /** 全量会话：项目分组按 projectId 过滤展示，多项目可同时展开。 */
  allSessions: Session[]
  standaloneSessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  runningSessionIds?: string[]
  completedSessionIds?: string[]
  failedSessionIds?: string[]
  approvalSessionIds?: string[]
  creatingProject: boolean
  onSelectProject: (projectId: string) => void
  /** 打开项目内会话：跨项目时切换项目上下文。 */
  onSelectProjectSession: (projectId: string, sessionId: string) => void
  onSelectStandaloneSession: (sessionId: string) => void
  onNewSessionInProject: (projectId: string) => void
  /** 点击项目行文件图标：切到该项目并让侧栏进入文件工作区。 */
  onEnterProjectFiles: (projectId: string) => void
  onCreateProject: () => Promise<void>
  onNewChat: () => void
  onDeleteProject: (projectId: string) => Promise<void>
  onRenameSession: (sessionId: string, title: string) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<void>
}

/**
 * 侧栏主体：过滤框 + 项目多展开分组 + 独立会话时间分组。
 * 项目行本身即展开开关（Codex 式，无折叠按钮）：点击展开并进入该项目，
 * 再点击收起；多个项目可同时展开。
 */
export function ChatsPanel(props: ChatsPanelProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const keyword = filter.trim().toLowerCase()
  const projects = useMemo(() => {
    const match = (text: string): boolean =>
      keyword === '' || text.toLowerCase().includes(keyword)
    return props.projects.filter((project) => match(project.name))
  }, [props.projects, keyword])
  // 项目名下的会话分组（多项目同时展开时各自过滤展示）。
  const sessionsByProject = useMemo(() => {
    const groups = new Map<string, Session[]>()
    for (const session of props.allSessions) {
      if (session.projectId === null) continue
      const list = groups.get(session.projectId)
      if (list) list.push(session)
      else groups.set(session.projectId, [session])
    }
    return groups
  }, [props.allSessions])
  const standalone = useMemo(() => {
    const match = (text: string): boolean =>
      keyword === '' || text.toLowerCase().includes(keyword)
    return props.standaloneSessions.filter((session) => match(session.title))
  }, [props.standaloneSessions, keyword])
  // 用户主动展开的项目集合；激活项目与搜索命中在此之上自动展开。
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  // 激活项目变化（新建/导入/启动恢复）时自动展开对应分组。
  useEffect(() => {
    const projectId = props.activeProjectId
    if (projectId === null) return
    setExpandedIds((current) =>
      current.has(projectId) ? current : new Set(current).add(projectId),
    )
  }, [props.activeProjectId])

  // 搜索时自动展开存在命中的项目（项目名或其下会话标题命中）。
  const expandedProjects = useMemo(() => {
    if (keyword === '') return expandedIds
    const result = new Set<string>()
    for (const project of projects) {
      const hasMatch =
        project.name.toLowerCase().includes(keyword) ||
        (sessionsByProject.get(project.id) ?? []).some((session) =>
          session.title.toLowerCase().includes(keyword),
        )
      if (hasMatch) result.add(project.id)
    }
    return result
  }, [keyword, expandedIds, projects, sessionsByProject])

  const matchesKeyword = (text: string): boolean =>
    keyword === '' || text.toLowerCase().includes(keyword)

  /**
   * 点击项目行：折叠时展开并进入该项目；已展开（含激活项目）时收起，
   * 收起不改变当前上下文。
   */
  const handleProjectRowClick = (projectId: string): void => {
    const willExpand = !expandedProjects.has(projectId)
    setExpandedIds((current) => {
      const next = new Set(current)
      if (willExpand) next.add(projectId)
      else next.delete(projectId)
      return next
    })
    if (willExpand && projectId !== props.activeProjectId) {
      props.onSelectProject(projectId)
    }
  }

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
            const expanded = expandedProjects.has(project.id)
            const projectSessions = sortByRunningFirst(
              (sessionsByProject.get(project.id) ?? []).filter((session) =>
                matchesKeyword(session.title),
              ),
              props.runningSessionIds,
            )
            return (
              <li key={project.id}>
                <div className={`project-row${active ? ' active' : ''}`}>
                  <button
                    className="row project-select"
                    title={project.folderPath || '未关联文件夹'}
                    aria-expanded={expanded}
                    onClick={() => handleProjectRowClick(project.id)}
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
                {expanded && (
                  <ul className="nested-list">
                    {projectSessions.map((session) => (
                      <li key={session.id}>
                        <SessionRow
                          session={session}
                          archiveBusy={props.archiveBusy}
                          onImport={
                            props.onImportChat
                              ? () => props.onImportChat?.(session.projectId)
                              : undefined
                          }
                          onExport={
                            props.onExportChat
                              ? () => props.onExportChat?.(session.id)
                              : undefined
                          }
                          active={session.id === props.activeSessionId}
                          running={props.runningSessionIds?.includes(
                            session.id,
                          )}
                          completed={props.completedSessionIds?.includes(
                            session.id,
                          )}
                          failed={props.failedSessionIds?.includes(session.id)}
                          pendingApproval={props.approvalSessionIds?.includes(
                            session.id,
                          )}
                          onSelect={() =>
                            props.onSelectProjectSession(project.id, session.id)
                          }
                          onRename={(title) =>
                            props.onRenameSession(session.id, title)
                          }
                          onDelete={() => props.onDeleteSession(session.id)}
                        />
                      </li>
                    ))}
                    {projectSessions.length === 0 && (
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
          <button
            className="icon-btn"
            title="新建独立对话"
            aria-label="新建独立对话"
            onClick={props.onNewChat}
          >
            <PlusIcon />
          </button>
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
              {sortByRunningFirst(sessions, props.runningSessionIds).map(
                (session) => (
                  <li key={session.id}>
                    <SessionRow
                      session={session}
                      archiveBusy={props.archiveBusy}
                      onImport={
                        props.onImportChat
                          ? () => props.onImportChat?.(session.projectId)
                          : undefined
                      }
                      onExport={
                        props.onExportChat
                          ? () => props.onExportChat?.(session.id)
                          : undefined
                      }
                      active={session.id === props.activeSessionId}
                      running={props.runningSessionIds?.includes(session.id)}
                      completed={props.completedSessionIds?.includes(
                        session.id,
                      )}
                      failed={props.failedSessionIds?.includes(session.id)}
                      pendingApproval={props.approvalSessionIds?.includes(
                        session.id,
                      )}
                      onSelect={() =>
                        props.onSelectStandaloneSession(session.id)
                      }
                      onRename={(title) =>
                        props.onRenameSession(session.id, title)
                      }
                      onDelete={() => props.onDeleteSession(session.id)}
                    />
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </div>
      {props.onImportChat &&
        !props.allSessions.length &&
        !props.standaloneSessions.length && (
          <button
            type="button"
            className="nav-item"
            disabled={props.archiveBusy}
            onClick={() => props.onImportChat?.(props.activeProjectId)}
          >
            导入聊天记录…
          </button>
        )}
    </div>
  )
}
