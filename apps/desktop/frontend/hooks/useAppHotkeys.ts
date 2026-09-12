import { useEffect, useRef } from 'react'
import { IS_MAC } from '../lib/platform'

export interface AppHotkeyHandlers {
  saveActive: () => void
  closeActiveTab: () => void
}

/**
 * 应用级快捷键（编辑器外兜底；编辑器内 Cmd/Ctrl+S 由 Monaco addCommand
 * 处理，其 keydown 不再冒泡到此处）：保存 Cmd/Ctrl+S；关标签
 * macOS Cmd+Shift+W（Cmd+W 被系统"关闭窗口"菜单占用）/ 其他平台 Ctrl+W。
 * 挂载时接线一次，回调经 latest-ref 读取（性能纪律）。
 */
export function useAppHotkeys(handlers: AppHotkeyHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 按住不放产生的自动重复不触发保存/关闭（否则连开弹窗）。
      if (event.repeat) return
      const mod = IS_MAC ? event.metaKey : event.ctrlKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        handlersRef.current.saveActive()
        return
      }
      if (key === 'w') {
        if (IS_MAC && !event.shiftKey) return
        event.preventDefault()
        handlersRef.current.closeActiveTab()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
