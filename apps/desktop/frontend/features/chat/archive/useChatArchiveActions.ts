import { useCallback, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { exportChatArchive, importChatArchive } from '../../../api/chat-archive'
import type { ChatArchiveImportParams } from '@reflexion-os-studio/contracts'
import type { ReadyAppProps } from '../../../components/ready-app-props'

export function useChatArchiveActions(props: ReadyAppProps) {
  const [importTarget, setImportTarget] = useState<{
    projectId: string | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const {
    activeProjectId,
    setNotice,
    guardedResetWorkspaceFiles,
    refreshProjects,
    refreshSessions,
    setActiveProjectId,
    openSession,
  } = props
  const openImport = useCallback((projectId: string | null) => {
    if (!lock.current) setImportTarget({ projectId })
  }, [])
  const closeImport = useCallback(() => setImportTarget(null), [])
  const exportChat = useCallback(
    async (sessionId: string) => {
      if (lock.current) return
      lock.current = true
      setBusy(true)
      try {
        const directory = await open({
          directory: true,
          multiple: false,
          title: '选择聊天记录导出目录',
        })
        if (typeof directory !== 'string') return
        const result = await exportChatArchive(sessionId, directory)
        setNotice(`已导出 ${result.messageCount} 条消息：${result.path}`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      } finally {
        lock.current = false
        setBusy(false)
      }
    },
    [setNotice],
  )
  const importChat = useCallback(
    async (input: Omit<ChatArchiveImportParams, 'requestId'>) => {
      if (lock.current) return false
      lock.current = true
      setBusy(true)
      try {
        if (
          (input.folderPath || (input.projectId ?? null) !== activeProjectId) &&
          !(await guardedResetWorkspaceFiles())
        )
          return false
        const result = await importChatArchive(input)
        // Acceptance has succeeded: a refresh error must not invite a duplicate import.
        setActiveProjectId(result.session.projectId)
        openSession(result.session.id)
        try {
          await refreshProjects()
          await refreshSessions()
          setNotice(`已导入 ${result.messageCount} 条消息，已打开新会话。`)
        } catch {
          setNotice('聊天记录已导入；列表刷新失败，请切换项目查看新会话。')
        }
        return true
      } finally {
        lock.current = false
        setBusy(false)
      }
    },
    [
      activeProjectId,
      guardedResetWorkspaceFiles,
      openSession,
      refreshProjects,
      refreshSessions,
      setActiveProjectId,
      setNotice,
    ],
  )
  return {
    importOpen: importTarget !== null,
    importProjectId: importTarget?.projectId ?? null,
    openImport,
    closeImport,
    busy,
    exportChat,
    importChat,
  }
}
