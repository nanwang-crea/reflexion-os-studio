import { Profiler, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import { AppMain } from '../../frontend/AppMain'
import { useWorkspacePanel } from '../../frontend/hooks/workspace/useWorkspacePanel'
import { useResourceRouter } from '../../frontend/hooks/useResourceRouter'
import '../../frontend/styles/style.css'
import '../../frontend/features/chat/chat.css'
import '../../frontend/features/workspace/workspace.css'
import '../../frontend/features/browser/browser.css'
import '../../frontend/components/feedback/empty-state.css'

loader.config({ monaco })
window.editors = []
monaco.editor.onDidCreateEditor((editor) => window.editors.push(editor))

function Fixture() {
  const [projectId, setProjectId] = useState('p')
  window.switchProject = () => setProjectId('p2')
  const activeProjectRef = useRef(projectId)
  activeProjectRef.current = projectId
  const [notice, setNotice] = useState<string | null>(null)
  const panel = useWorkspacePanel(projectId)
  const openResource = useResourceRouter({
    projects: [{ id: 'p' }, { id: 'other' }, { id: 'p2' }],
    activeProjectRef,
    setNotice,
    setWorkspaceOpen: panel.setWorkspaceOpen,
    setWorkspaceRequest: panel.setWorkspaceRequest,
  })
  useEffect(() => {
    const request = panel.workspaceRequest
    if (!request) return
    panel.setWorkspaceRequest(null)
    if (request.kind === 'file' && request.projectId === projectId)
      panel.openFile(request.path, request.line)
  }, [
    panel.workspaceRequest,
    panel.openFile,
    panel.setWorkspaceRequest,
    projectId,
  ])
  window.navigationState = { open: panel.workspaceOpen, tabs: panel.openTabs }
  return (
    <AppMain
      view="chat"
      activeSessionId="session"
      notice={notice}
      onDismissNotice={() => setNotice(null)}
      topBar={{
        sidebarOpen: false,
        onToggleSidebar() {},
        runtimeState: 'system-ready',
        statusLabel: '就绪',
      }}
      chat={{ onResourceClick: openResource }}
      landing={{}}
      settings={{}}
      instructions={{}}
      onUseSkill={() => {}}
      terminal={{
        open: false,
        onToggle() {},
        activeProjectId: projectId,
        confirm: async () => true,
      }}
      workspace={{
        open: panel.workspaceOpen,
        setOpen: panel.setWorkspaceOpen,
        width: 600,
        setWidth: panel.setWorkspaceWidth,
        panel: {
          project: { id: projectId },
          systemReady: true,
          openTabs: panel.openTabs,
          activeTabId: panel.activeTabId,
          dirtyPaths: panel.dirtyPaths,
          onSelectTab: panel.selectTab,
          onRequestCloseTab: panel.closeTab,
          onReorderTabs: panel.reorderTabs,
          onDirtyChange: panel.setTabDirty,
          confirm: async () => true,
          onResourceClick: openResource,
        },
      }}
    />
  )
}
window.commits = 0
createRoot(document.getElementById('root')!).render(
  <Profiler id="navigation" onRender={() => window.commits++}>
    <Fixture />
  </Profiler>,
)
