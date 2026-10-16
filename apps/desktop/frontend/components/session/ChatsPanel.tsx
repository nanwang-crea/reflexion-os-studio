import { useMemo, useState } from 'react'
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

interface ChatsPanelProps {
  onImportChat?: (projectId: string | null) => void
  onExportChat?: (sessionId: string) => void
  archiveBusy?: boolean
  projects: Project[]
  projectSessions: Session[]
  standaloneSessions: Session[]
  activeProjectId: string | null
  activeSessionId: string | null
  runningSessionIds?: string[]
  completedSessionIds?: string[]
  failedSessionIds?: string[]
  approvalSessionIds?: string[]
  creatingProject: boolean
  onSelectProject: (projectId: string) => void
  onSelectSession: (sessionId: string) => void
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

/** 侧栏主体：过滤框 + 项目折叠区 + 独立会话时间分组。 */
export function ChatsPanel(props: ChatsPanelProps): React.JSX.Element {
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
                    {[...props.projectSessions]
                      .sort(
                        (a, b) =>
                          Number(
                            props.runningSessionIds?.includes(b.id) ?? false,
                          ) -
                          Number(
                            props.runningSessionIds?.includes(a.id) ?? false,
                          ),
                      )
                      .map((session) => (
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
                            failed={props.failedSessionIds?.includes(
                              session.id,
                            )}
                            pendingApproval={props.approvalSessionIds?.includes(
                              session.id,
                            )}
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
              {[...sessions]
                .sort(
                  (a, b) =>
                    Number(props.runningSessionIds?.includes(b.id) ?? false) -
                    Number(props.runningSessionIds?.includes(a.id) ?? false),
                )
                .map((session) => (
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
                ))}
            </ul>
          </div>
        ))}
      </div>
      {props.onImportChat &&
        !props.projectSessions.length &&
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
