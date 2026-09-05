import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  SkillManifest,
  Delegation,
} from '@reflexion-os-studio/runtime-client'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionMode } from './hooks/usePermissionMode'
import { listProviders } from './api/providers'
import { listProjects } from './api/projects'
import { resolveApproval } from './api/chat'
import { listSkills } from './api/skills'
import { listDelegations } from './api/agents'
import { getSessionData, listSessions, type SessionData } from './api/sessions'
import {
  ConfirmDialog,
  type ConfirmDialogState,
} from './components/ConfirmDialog'
import { ChatView } from './features/chat/ChatView'
import { LandingView } from './features/landing/LandingView'
import { MemoryView } from './features/memories/MemoryView'
import { Sidebar } from './components/Sidebar'
import { SkillsView } from './features/skills/SkillsView'
import { AutomationsView } from './features/automations/AutomationsView'
import { FileViewerPanel } from './features/workspace/FileViewerPanel'
import type {
  OpenFileTab,
  WorkspaceOpenRequest,
} from './features/workspace/types'
import { SettingsView } from './features/settings/SettingsView'
import { useSessionActions } from './hooks/useSessionActions'
import { useResourceRouter } from './hooks/useResourceRouter'
import { DoubleChevronIcon, FolderIcon } from './ui/icons'

const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

export default function App() {
  const [view, setView] = useState<
    'chat' | 'settings' | 'memories' | 'skills' | 'automations'
  >('chat')
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [skills, setSkills] = useState<SkillManifest[]>([])
  // SkillsView 点击"在对话中使用"：记一个 nonce 触发 Composer 预填 /<skillId>。
  const [composerPrefill, setComposerPrefill] = useState<{
    skillId: string
    nonce: number
  } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSessions, setProjectSessions] = useState<Session[]>([])
  const [standaloneSessions, setStandaloneSessions] = useState<Session[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [creatingProject, setCreatingProject] = useState(false)
  // 侧栏开合（单栏 Codex 式）：收起时隐藏侧栏但保留挂载状态。
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('reflexion.sidebarOpen') !== '0',
  )
  // 侧栏内容模式：chat=会话列表；files=当前项目文件工作区。
  const [sidebarMode, setSidebarMode] = useState<'chat' | 'files'>('chat')
  // 侧栏可拖拽宽度。
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem('reflexion.sidebarWidth'))
    return Number.isFinite(stored) && stored >= 200 ? stored : 272
  })
  // 对话右侧工作区面板（Codex 右侧文件栏式）：默认展开，按用户偏好记忆。
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem('reflexion.workspacePanel') !== '0',
  )
  // 右侧文件查看器可拖拽宽度。
  const [workspaceWidth, setWorkspaceWidth] = useState(() => {
    const stored = Number(localStorage.getItem('reflexion.workspaceWidth'))
    return Number.isFinite(stored) && stored >= 280 ? stored : 420
  })
  // 右侧查看器已打开的文件标签（顺序）+ 当前激活标签 path。
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  // 资源链接里的 asset:// 定位请求，转发给侧栏资产视图聚焦。
  const [filesFocusAssetId, setFilesFocusAssetId] = useState<string | null>(
    null,
  )
  // 资源链接点击产生的面板定位请求；nonce 区分每次点击。
  const [workspaceRequest, setWorkspaceRequest] =
    useState<WorkspaceOpenRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const sessionRequestRef = useRef(0)

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarOpen', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem('reflexion.workspacePanel', workspaceOpen ? '1' : '0')
  }, [workspaceOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.workspaceWidth', String(workspaceWidth))
  }, [workspaceWidth])

  const { permissionMode, changePermissionMode } = usePermissionMode()
  const { modelOptions, selectedModelKey, setSelectedModelKey } =
    useModelSelection(profiles, sessionData, activeSessionId)

  const refreshSessionData = useCallback(async (sessionId: string) => {
    const requestId = ++sessionRequestRef.current
    const result = await getSessionData(sessionId)
    // 请求期间可能已切换到其他会话：丢弃过期响应，避免旧会话覆盖当前页。
    if (requestId === sessionRequestRef.current) setSessionData(result)
  }, [])

  const refreshProfiles = useCallback(async () => {
    const result = await listProviders()
    setProfiles(result.profiles)
  }, [])

  const refreshProjects = useCallback(async () => {
    const result = await listProjects()
    setProjects(result.projects)
  }, [])

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    const result = await listSessions(projectId)
    setProjectSessions(result.sessions)
  }, [])

  const refreshStandaloneSessions = useCallback(async () => {
    const result = await listSessions(null)
    setStandaloneSessions(result.sessions)
  }, [])

  const refreshDelegations = useCallback(async (sessionId: string) => {
    const delegationsList = await listDelegations(sessionId)
    setDelegations(delegationsList)
  }, [])

  // deps 对象必须稳定：useAppBootstrap 内部的引导 effect 以它为依赖，
  // 每次渲染重建会导致事件监听反复重挂、启动拉取反复触发。
  const bootstrapDeps = useMemo(
    () => ({
      activeSessionRef,
      activeProjectRef,
      refreshProfiles,
      refreshProjects,
      refreshSessionData,
      refreshStandaloneSessions,
      refreshProjectSessions,
      refreshDelegations,
      setNotice,
    }),
    [
      activeProjectRef,
      activeSessionRef,
      refreshProjectSessions,
      refreshProfiles,
      refreshProjects,
      refreshSessionData,
      refreshStandaloneSessions,
      refreshDelegations,
      setNotice,
    ],
  )

  const {
    bootstrap,
    streaming,
    streamingReasoning,
    runActivities,
    resetStreaming,
    pendingApprovals,
    memoryNotice,
  } = useAppBootstrap(bootstrapDeps)

  /** 审批决策：approval.resolve 命令；事件回执负责移除等待卡片。 */
  const handleResolveApproval = useCallback(
    async (
      toolCallId: string,
      decision: 'approved' | 'denied',
      scope: 'once' | 'session',
    ): Promise<void> => {
      try {
        await resolveApproval({ toolCallId, decision, scope })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [],
  )

  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    activeProjectRef.current = activeProjectId
  }, [activeProjectId])

  /** 应用内确认弹窗：promise 风格，供变更类操作等待用户决定。 */
  const confirm = useCallback((state: ConfirmDialogState): Promise<boolean> => {
    return new Promise((resolve) => {
      // 理论上不会连开两个弹窗；万一发生，先了结旧 promise 避免挂起。
      confirmResolverRef.current?.(false)
      confirmResolverRef.current = resolve
      setConfirmState(state)
    })
  }, [])

  const settleConfirm = useCallback((ok: boolean): void => {
    setConfirmState(null)
    confirmResolverRef.current?.(ok)
    confirmResolverRef.current = null
  }, [])

  const handleConfirm = useCallback(() => settleConfirm(true), [settleConfirm])
  const handleCancel = useCallback(() => settleConfirm(false), [settleConfirm])

  const openSession = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    resetStreaming()
    void refreshSessionData(sessionId)
    void refreshDelegations(sessionId)
  }

  const selectProject = (projectId: string): void => {
    setActiveProjectId(projectId)
    setActiveSessionId(null)
    setSessionData(null)
    setDelegations([])
    setView('chat')
    // 文件标签只属于当前项目：切项目时清空。
    setOpenTabs([])
    setActiveFilePath(null)
    setFilesFocusAssetId(null)
    void refreshProjectSessions(projectId)
  }

  const selectLandingProject = useCallback(
    (projectId: string | null): void => {
      setActiveProjectId(projectId)
      setActiveSessionId(null)
      setSessionData(null)
      setDelegations([])
      if (projectId !== null) {
        setOpenTabs([])
        setActiveFilePath(null)
        setFilesFocusAssetId(null)
        void refreshProjectSessions(projectId)
      }
    },
    [refreshProjectSessions],
  )

  const selectStandaloneSession = (sessionId: string): void => {
    setActiveProjectId(null)
    openSession(sessionId)
  }

  const newStandaloneChat = (): void => {
    setActiveProjectId(null)
    setActiveSessionId(null)
    setSessionData(null)
    setDelegations([])
    setView('chat')
  }

  /** 点击项目行文件图标：切到对应项目并让侧栏进入文件工作区。 */
  const enterProjectFiles = useCallback(
    (projectId: string): void => {
      setActiveProjectId(projectId)
      setActiveSessionId(null)
      setSessionData(null)
      setDelegations([])
      setView('chat')
      setSidebarMode('files')
      setSidebarOpen(true)
      setOpenTabs([])
      setActiveFilePath(null)
      setFilesFocusAssetId(null)
      void refreshProjectSessions(projectId)
    },
    [refreshProjectSessions],
  )

  const backToChat = useCallback((): void => {
    setSidebarMode('chat')
  }, [])

  /** 在右侧查看器打开/激活一个文件标签；重复点击只切标签不重复创建。 */
  const openFile = useCallback((path: string, line?: number): void => {
    const nonce = Date.now()
    setOpenTabs((tabs) => {
      const existing = tabs.find((tab) => tab.path === path)
      if (!existing) return [...tabs, { path, line, nonce }]
      // 已打开：仅更新跳转定位（若提供），供 ContentView 重新应用 initialLine。
      if (line !== undefined) {
        return tabs.map((tab) =>
          tab.path === path ? { ...tab, line, nonce } : tab,
        )
      }
      return tabs
    })
    setActiveFilePath(path)
    setWorkspaceOpen(true)
  }, [])

  const closeTab = useCallback(
    (path: string): void => {
      setOpenTabs((tabs) => {
        const index = tabs.findIndex((tab) => tab.path === path)
        const next = tabs.filter((tab) => tab.path !== path)
        if (activeFilePath === path) {
          // 关闭当前激活标签：激活紧随其后的标签（为最后一个时回到前一个）。
          const neighbor = next[Math.min(index, next.length - 1)] ?? null
          setActiveFilePath(neighbor ? neighbor.path : null)
        }
        return next
      })
    },
    [activeFilePath],
  )

  const selectTab = useCallback((path: string): void => {
    setActiveFilePath(path)
  }, [])

  const {
    createProject,
    deleteProject,
    renameSession,
    deleteSession,
    sendMessage,
    stopRun,
    retryRun,
  } = useSessionActions({
    projects,
    activeSessionId,
    activeProjectId,
    selectedModelKey,
    sessionData,
    permissionMode,
    activeSessionRef,
    activeProjectRef,
    refreshSessionData,
    refreshStandaloneSessions,
    refreshProjectSessions,
    refreshProjects,
    setActiveSessionId,
    setActiveProjectId,
    setSessionData,
    setProjectSessions,
    setCreatingProject,
    setNotice,
    confirm,
    selectProject,
  })

  const hasEnabledProvider = profiles.some((profile) => profile.enabled)
  const statusLabel = bootstrap
    ? (STATUS_LABELS[bootstrap.state] ?? bootstrap.state)
    : '启动中…'
  const runtimeReady = bootstrap?.runtimeReady ?? false

  // 技能清单是内置静态数据，runtime 一就绪就拉一次；失败不阻塞聊天。
  useEffect(() => {
    if (!runtimeReady) return
    listSkills()
      .then((result) => setSkills(result.skills))
      .catch(() => {})
  }, [runtimeReady])

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null

  const handleResourceClick = useResourceRouter({
    activeProjectRef,
    setWorkspaceRequest,
    setWorkspaceOpen,
    setNotice,
  })

  useEffect(() => {
    const request = workspaceRequest
    if (request === null) return
    if (request.kind === 'file') {
      openFile(request.path, request.line)
    } else {
      setSidebarMode('files')
      setSidebarOpen(true)
      setFilesFocusAssetId(request.assetId)
    }
  }, [workspaceRequest, openFile])

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
              ? (sessionData?.session?.title ?? '对话')
              : activeProject
                ? activeProject.name
                : '新对话'

  if (!runtimeReady) {
    return (
      <div className="boot-screen">
        <h1>ReflexionOS Studio</h1>
        <p className="boot-status">{statusLabel}</p>
        <p className="boot-detail">{bootstrap?.detail ?? 'M0 Bootstrap'}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        width={sidebarWidth}
        mode={sidebarMode}
        projects={projects}
        projectSessions={projectSessions}
        standaloneSessions={standaloneSessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        creatingProject={creatingProject}
        view={view}
        systemReady={bootstrap?.systemReady ?? false}
        activeFilePath={openTabs.length > 0 ? activeFilePath : null}
        focusAssetId={filesFocusAssetId}
        onFocusConsumed={() => setFilesFocusAssetId(null)}
        onOpenFile={openFile}
        onEnterProjectFiles={enterProjectFiles}
        onBackToChat={backToChat}
        onSelectProject={selectProject}
        onSelectSession={openSession}
        onSelectStandaloneSession={selectStandaloneSession}
        onNewSessionInProject={selectProject}
        onNewChat={newStandaloneChat}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onSelectView={(nextView) => {
          // 底部导航：打开对应页面；点已激活项回到聊天。
          setView((current) => (current === nextView ? 'chat' : nextView))
        }}
      />
      <ResizeHandle
        onResize={(delta) =>
          setSidebarWidth((width) =>
            Math.max(200, Math.min(560, width + delta)),
          )
        }
      />
      <div className="main-pane">
        <header className="topbar">
          <button
            type="button"
            className="topbar-toggle"
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <DoubleChevronIcon direction={sidebarOpen ? 'left' : 'right'} />
          </button>
          <span className="topbar-title">{contextTitle}</span>
          <span className="spacer" />
          {view === 'chat' && (
            <button
              type="button"
              className={`topbar-toggle${workspaceOpen ? ' active' : ''}`}
              title={workspaceOpen ? '收起工作区面板' : '展开工作区面板'}
              aria-label="工作区面板"
              aria-pressed={workspaceOpen}
              onClick={() => setWorkspaceOpen((open) => !open)}
            >
              <FolderIcon />
            </button>
          )}
          {memoryNotice && (
            <span className="badge badge-memory">{memoryNotice}</span>
          )}
          {bootstrap?.state !== 'system-ready' && (
            <span className={`badge badge-${bootstrap?.state ?? ''}`}>
              {statusLabel}
            </span>
          )}
        </header>

        {notice && (
          <div className="notice" role="alert" aria-live="assertive">
            <span>{notice}</span>
            <button
              type="button"
              className="ghost"
              onClick={() => setNotice(null)}
            >
              关闭
            </button>
          </div>
        )}

        <div className="content-area">
          <div className="content-main">
            {view === 'settings' ? (
              <SettingsView
                profiles={profiles}
                onSaved={() => refreshProfiles()}
                onBackToChat={() => setView('chat')}
                confirm={confirm}
              />
            ) : view === 'memories' ? (
              <MemoryView confirm={confirm} />
            ) : view === 'skills' ? (
              <SkillsView
                onUseSkill={(skillId, sessionId) => {
                  setActiveProjectId(null)
                  setActiveSessionId(sessionId)
                  void refreshSessionData(sessionId)
                  void refreshStandaloneSessions()
                  setComposerPrefill({ skillId, nonce: Date.now() })
                  setView('chat')
                }}
              />
            ) : view === 'automations' ? (
              <AutomationsView />
            ) : activeSessionId ? (
              <ChatView
                sessionData={sessionData}
                delegations={delegations}
                streaming={streaming}
                streamingReasoning={streamingReasoning}
                runActivities={runActivities}
                hasEnabledProvider={hasEnabledProvider}
                permissionValue={permissionMode}
                onPermissionChange={changePermissionMode}
                modelOptions={modelOptions}
                selectedModelKey={selectedModelKey}
                onModelChange={setSelectedModelKey}
                skills={skills}
                composerPrefill={composerPrefill}
                onPrefillConsumed={() => setComposerPrefill(null)}
                onSend={sendMessage}
                onStop={stopRun}
                onRetry={retryRun}
                onGoSettings={() => {
                  setView('settings')
                }}
                pendingApprovals={pendingApprovals}
                onResolveApproval={handleResolveApproval}
                onResourceClick={handleResourceClick}
              />
            ) : (
              <LandingView
                project={activeProject}
                projects={projects}
                selectedProjectId={activeProjectId}
                onProjectChange={selectLandingProject}
                sessions={activeProject ? projectSessions : []}
                hasEnabledProvider={hasEnabledProvider}
                permissionValue={permissionMode}
                onPermissionChange={changePermissionMode}
                modelOptions={modelOptions}
                selectedModelKey={selectedModelKey}
                onModelChange={setSelectedModelKey}
                skills={skills}
                composerPrefill={composerPrefill}
                onPrefillConsumed={() => setComposerPrefill(null)}
                onSend={sendMessage}
                onSelectSession={openSession}
                onRenameSession={renameSession}
                onDeleteSession={deleteSession}
                onGoSettings={() => {
                  setView('settings')
                }}
              />
            )}
          </div>
          {view === 'chat' && workspaceOpen && (
            <>
              <ResizeHandle
                reverse
                onResize={(delta) =>
                  setWorkspaceWidth((width) =>
                    Math.max(280, Math.min(900, width - delta)),
                  )
                }
              />
              <FileViewerPanel
                project={activeProject}
                systemReady={bootstrap?.systemReady ?? false}
                openTabs={openTabs}
                activePath={activeFilePath}
                onSelectTab={selectTab}
                onCloseTab={closeTab}
                width={workspaceWidth}
              />
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  )
}

interface ResizeHandleProps {
  /** 向右拖动时宽度增量回调；reverse 用于右侧面板（面板在分隔线右侧）。 */
  reverse?: boolean
  onResize: (delta: number) => void
}

/** 可拖拽分栏分隔条：按住拖动调整相邻面板宽度（pointer capture）。 */
function ResizeHandle(props: ResizeHandleProps): React.JSX.Element {
  const draggingRef = useRef(false)
  const lastXRef = useRef(0)

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(event) => {
        event.preventDefault()
        draggingRef.current = true
        lastXRef.current = event.clientX
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return
        const delta = event.clientX - lastXRef.current
        lastXRef.current = event.clientX
        props.onResize(props.reverse ? -delta : delta)
      }}
      onPointerUp={(event) => {
        if (!draggingRef.current) return
        draggingRef.current = false
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        draggingRef.current = false
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
    />
  )
}
