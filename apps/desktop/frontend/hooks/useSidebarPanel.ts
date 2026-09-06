import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export type SidebarMode = 'chat' | 'files'

export interface SidebarPanelState {
  sidebarOpen: boolean
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
  sidebarMode: SidebarMode
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>
  sidebarWidth: number
  setSidebarWidth: Dispatch<SetStateAction<number>>
}

/**
 * 侧栏开合 / 内容模式 / 宽度状态：开合与宽度偏好持久化到 localStorage。
 * 侧栏内容模式（chat=会话列表，files=项目文件工作区）只在内存中切换。
 */
export function useSidebarPanel(): SidebarPanelState {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('reflexion.sidebarOpen') !== '0',
  )
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('chat')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem('reflexion.sidebarWidth'))
    return Number.isFinite(stored) && stored >= 200 ? stored : 272
  })

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarOpen', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarMode,
    setSidebarMode,
    sidebarWidth,
    setSidebarWidth,
  }
}
