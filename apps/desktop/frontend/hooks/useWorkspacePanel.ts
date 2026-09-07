import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  OpenFileTab,
  WorkspaceOpenRequest,
} from '../features/workspace/types'

export interface WorkspacePanelState {
  workspaceOpen: boolean
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>
  workspaceWidth: number
  setWorkspaceWidth: Dispatch<SetStateAction<number>>
  openTabs: OpenFileTab[]
  activeFilePath: string | null
  filesFocusAssetId: string | null
  setFilesFocusAssetId: Dispatch<SetStateAction<string | null>>
  workspaceRequest: WorkspaceOpenRequest | null
  setWorkspaceRequest: Dispatch<SetStateAction<WorkspaceOpenRequest | null>>
  /** 在右侧查看器打开/激活一个文件标签；重复点击只切标签不重复创建。 */
  openFile: (path: string, line?: number) => void
  openDiff: (
    path: string,
    options?: {
      staged?: boolean
      oldPath?: string
      source?: 'git' | 'chat'
      before?: string
      after?: string
    },
  ) => void
  closeTab: (path: string) => void
  selectTab: (path: string) => void
  /** 按拖拽结果重新排序标签：paths 为新的打开顺序。 */
  reorderTabs: (paths: string[]) => void
  /** 切换项目时清空属于上一个项目的文件标签与聚焦。 */
  resetWorkspaceFiles: () => void
}

/**
 * 对话右侧文件工作区面板状态：开合/宽度偏好持久化，文件标签、激活文件、
 * 资产聚焦与资源定位请求只在内存中维护（标签跟随当前项目生命周期）。
 */
export function useWorkspacePanel(): WorkspacePanelState {
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem('reflexion.workspacePanel') !== '0',
  )
  const [workspaceWidth, setWorkspaceWidth] = useState(() => {
    const stored = Number(localStorage.getItem('reflexion.workspaceWidth'))
    return Number.isFinite(stored) && stored >= 280 ? stored : 420
  })
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  // 资源链接里的 asset:// 定位请求，转发给侧栏资产视图聚焦。
  const [filesFocusAssetId, setFilesFocusAssetId] = useState<string | null>(
    null,
  )
  // 资源链接点击产生的面板定位请求；nonce 区分每次点击。
  const [workspaceRequest, setWorkspaceRequest] =
    useState<WorkspaceOpenRequest | null>(null)

  useEffect(() => {
    localStorage.setItem('reflexion.workspacePanel', workspaceOpen ? '1' : '0')
  }, [workspaceOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.workspaceWidth', String(workspaceWidth))
  }, [workspaceWidth])

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

  const openDiff = useCallback(
    (
      path: string,
      options: {
        staged?: boolean
        oldPath?: string
        source?: 'git' | 'chat'
        before?: string
        after?: string
      } = {},
    ): void => {
      const nonce = Date.now()
      setOpenTabs((tabs) => {
        const existing = tabs.find(
          (tab) => tab.path === path && tab.mode === 'diff',
        )
        if (existing) {
          return tabs.map((tab) =>
            tab === existing
              ? { ...tab, ...options, nonce, mode: 'diff' }
              : tab,
          )
        }
        return [...tabs, { path, mode: 'diff', nonce, ...options }]
      })
      setActiveFilePath(path)
      setWorkspaceOpen(true)
    },
    [],
  )

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

  const reorderTabs = useCallback((paths: string[]): void => {
    setOpenTabs((tabs) => {
      const byPath = new Map(tabs.map((tab) => [tab.path, tab]))
      const next: OpenFileTab[] = []
      for (const path of paths) {
        const tab = byPath.get(path)
        if (tab !== undefined) next.push(tab)
      }
      return next
    })
  }, [])

  const resetWorkspaceFiles = useCallback((): void => {
    setOpenTabs([])
    setActiveFilePath(null)
    setFilesFocusAssetId(null)
  }, [])

  return {
    workspaceOpen,
    setWorkspaceOpen,
    workspaceWidth,
    setWorkspaceWidth,
    openTabs,
    activeFilePath,
    filesFocusAssetId,
    setFilesFocusAssetId,
    workspaceRequest,
    setWorkspaceRequest,
    openFile,
    openDiff,
    closeTab,
    selectTab,
    reorderTabs,
    resetWorkspaceFiles,
  }
}
