import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  OpenFileTab,
  WorkspaceOpenRequest,
} from '../features/workspace/types'
import { tabIdOf } from '../features/workspace/types'

export interface WorkspacePanelState {
  workspaceOpen: boolean
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>
  workspaceWidth: number
  setWorkspaceWidth: Dispatch<SetStateAction<number>>
  openTabs: OpenFileTab[]
  /** 当前激活标签的 tabId（content=path / diff=path#diff）；null 表示无激活。 */
  activeTabId: string | null
  /** 当前激活标签对应的文件路径（侧栏树高亮、保存快捷键用）。 */
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
  /** 按 tabId 关闭标签（同路径的 content 与 diff 标签互不影响）。 */
  closeTab: (id: string) => void
  /** 按 tabId 激活标签。 */
  selectTab: (id: string) => void
  /** 按拖拽结果重新排序标签：ids 为新的 tabId 打开顺序。 */
  reorderTabs: (ids: string[]) => void
  /** 切换项目时清空属于上一个项目的文件标签与聚焦。 */
  resetWorkspaceFiles: () => void
  /** 已修改未保存的文件路径集合（按 path 键控，仅 content 标签会脏）。 */
  dirtyPaths: Set<string>
  /** 编辑内核脏状态上抛入口（值不变时 no-op，防键击级重渲染）。 */
  setTabDirty: (path: string, dirty: boolean) => void
}

/**
 * 对话右侧文件工作区面板状态：开合/宽度偏好持久化，文件标签、激活标签、
 * 资产聚焦与资源定位请求只在内存中维护（标签跟随当前项目生命周期）。
 * 标签身份是 tabId（content=path、diff=path#diff）：同一路径允许同时存在
 * content 与 diff 两个标签，互不串扰；dirtyPaths 仍按 path 键控。
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
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  // 激活标签对应的 path：侧栏文件树高亮与保存快捷键按 path 消费。
  const activeFilePath =
    openTabs.find((tab) => tabIdOf(tab) === activeTabId)?.path ?? null
  // 资源链接里的 asset:// 定位请求，转发给侧栏资产视图聚焦。
  const [filesFocusAssetId, setFilesFocusAssetId] = useState<string | null>(
    null,
  )
  // 资源链接点击产生的面板定位请求；nonce 区分每次点击。
  const [workspaceRequest, setWorkspaceRequest] =
    useState<WorkspaceOpenRequest | null>(null)

  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set())

  // latest-ref：让 closeTab 等回调身份稳定（AGENTS §10），不捕获渲染态。
  const openTabsRef = useRef(openTabs)
  openTabsRef.current = openTabs
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  const setTabDirty = useCallback((path: string, dirty: boolean): void => {
    setDirtyPaths((prev) => {
      if (prev.has(path) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  useEffect(() => {
    localStorage.setItem('reflexion.workspacePanel', workspaceOpen ? '1' : '0')
  }, [workspaceOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.workspaceWidth', String(workspaceWidth))
  }, [workspaceWidth])

  const openFile = useCallback((path: string, line?: number): void => {
    const nonce = Date.now()
    setOpenTabs((tabs) => {
      // 只在 content 标签里找同路径项：仅有 diff 标签时应新建 content 标签。
      const existing = tabs.find(
        (tab) => tab.path === path && tab.mode !== 'diff',
      )
      if (!existing) return [...tabs, { path, line, nonce }]
      // 已打开：仅更新跳转定位（若提供），供 ContentView 重新应用 initialLine。
      if (line !== undefined) {
        return tabs.map((tab) =>
          tab === existing ? { ...tab, line, nonce } : tab,
        )
      }
      return tabs
    })
    setActiveTabId(path)
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
      setActiveTabId(`${path}#diff`)
      setWorkspaceOpen(true)
    },
    [],
  )

  const closeTab = useCallback((id: string): void => {
    const tabs = openTabsRef.current
    const closing = tabs.find((tab) => tabIdOf(tab) === id)
    if (closing === undefined) return
    const index = tabs.indexOf(closing)
    const next = tabs.filter((tab) => tabIdOf(tab) !== id)
    if (activeTabIdRef.current === id) {
      // 关闭当前激活标签：激活紧随其后的标签（为最后一个时回到前一个）。
      const neighbor = next[Math.min(index, next.length - 1)] ?? null
      setActiveTabId(neighbor ? tabIdOf(neighbor) : null)
    }
    setOpenTabs(next)
    // dirtyPaths 按 path 键控：只有关闭 content 标签才清脏点。diff 标签
    // 永远不会脏，关闭它不得清掉同路径 content 标签的脏点。content 标签
    // 每路径唯一，故无需再检查是否还有同路径的非 diff 标签。
    if (closing.mode !== 'diff') {
      const path = closing.path
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev
        const cleared = new Set(prev)
        cleared.delete(path)
        return cleared
      })
    }
  }, [])

  const selectTab = useCallback((id: string): void => {
    setActiveTabId(id)
  }, [])

  const reorderTabs = useCallback((ids: string[]): void => {
    setOpenTabs((tabs) => {
      const byId = new Map(tabs.map((tab) => [tabIdOf(tab), tab]))
      const next: OpenFileTab[] = []
      for (const id of ids) {
        const tab = byId.get(id)
        if (tab !== undefined) next.push(tab)
      }
      return next
    })
  }, [])

  const resetWorkspaceFiles = useCallback((): void => {
    setOpenTabs([])
    setActiveTabId(null)
    setFilesFocusAssetId(null)
    setDirtyPaths(new Set())
  }, [])

  return {
    workspaceOpen,
    setWorkspaceOpen,
    workspaceWidth,
    setWorkspaceWidth,
    openTabs,
    activeTabId,
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
    dirtyPaths,
    setTabDirty,
  }
}
