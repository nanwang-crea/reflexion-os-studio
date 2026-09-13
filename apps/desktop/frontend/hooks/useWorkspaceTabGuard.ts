import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { FileViewerPanelHandle } from '../features/workspace/FileViewerPanel'
import type { OpenFileTab } from '../features/workspace/types'
import { tabIdOf } from '../features/workspace/types'
import type { ConfirmDialogState } from '../components/ConfirmDialog'
import type { ConfirmResult } from './useConfirmDialog'

interface WorkspaceTabGuardDeps {
  openTabs: OpenFileTab[]
  dirtyPaths: Set<string>
  closeTab: (id: string) => void
  resetWorkspaceFiles: () => void
  confirmAction: (state: ConfirmDialogState) => Promise<ConfirmResult>
  setNotice: (message: string) => void
  filePanelRef: RefObject<FileViewerPanelHandle | null>
}

export interface WorkspaceTabGuard {
  /** 关闭标签请求（按 tabId）：脏文件先弹三键确认（保存并关闭/不保存/取消）。 */
  requestCloseTab: (id: string) => Promise<void>
  /** 缓冲守卫：dirtyPaths 非空时三键（保存全部/放弃/取消），返回是否可继续。 */
  /** 通用缓冲守卫（切分支/拉取前用）：文案可按场景覆盖。 */
  guardDirtyBuffersThen: (options?: {
    message?: string
    confirmLabel?: string
    tertiaryLabel?: string
  }) => Promise<boolean>
  /** 切项目/会话前的清空守卫：返回 false 表示用户取消切换。 */
  guardedResetWorkspaceFiles: () => Promise<boolean>
}

/**
 * 文件标签关闭/切换守卫：脏文件的三类数据丢失口子（关标签、切项目、
 * 关窗口）统一在此编排确认弹窗；deps 经 latest-ref 读取，回调身份稳定。
 * 关闭以 tabId 定位标签；dirtyPaths 按 path 键控，脏判断用标签的 path。
 */
export function useWorkspaceTabGuard(
  deps: WorkspaceTabGuardDeps,
): WorkspaceTabGuard {
  const latest = useRef(deps)
  latest.current = deps

  const requestCloseTab = useCallback(async (id: string): Promise<void> => {
    const {
      openTabs,
      dirtyPaths,
      closeTab,
      confirmAction,
      setNotice,
      filePanelRef,
    } = latest.current
    const tab = openTabs.find((item) => tabIdOf(item) === id)
    if (tab === undefined) return
    const { path } = tab
    // diff 标签无编辑内核永不脏：不能被同 path 的 content 标签脏状态误拦。
    if (tab.mode === 'diff' || !dirtyPaths.has(path)) {
      closeTab(id)
      return
    }
    const fileName = path.split('/').pop() ?? path
    const result = await confirmAction({
      title: '有未保存的修改',
      message: `${fileName} 有未保存的修改，关闭后将丢失。`,
      confirmLabel: '保存并关闭',
      tertiaryLabel: '不保存',
    })
    if (result === 'cancel') return
    if (result === 'confirm') {
      const ok = (await filePanelRef.current?.saveDirty(path)) ?? false
      if (!ok) {
        setNotice('保存失败，已保留标签页；请在编辑器中查看错误。')
        return
      }
    }
    // await 之后重新读取最新身份：closeTab 闭包捕获的激活态可能已过期。
    latest.current.closeTab(id)
  }, [])

  /** 缓冲守卫：dirtyPaths 非空时三键（保存全部/放弃/取消），返回是否可继续。 */
  const guardDirtyBuffersThen = useCallback(
    async (options?: {
      message?: string
      confirmLabel?: string
      tertiaryLabel?: string
    }): Promise<boolean> => {
      const { dirtyPaths, confirmAction, setNotice, filePanelRef } =
        latest.current
      if (dirtyPaths.size === 0) return true
      const result = await confirmAction({
        title: '有未保存的修改',
        message:
          options?.message ??
          `接下来将改变工作区文件，${dirtyPaths.size} 个未保存文件需先处理。`,
        confirmLabel: options?.confirmLabel ?? '保存全部并继续',
        tertiaryLabel: options?.tertiaryLabel ?? '放弃修改并继续',
      })
      if (result === 'cancel') return false
      if (result === 'confirm') {
        const { failed } = (await filePanelRef.current?.saveAllDirty()) ?? {
          saved: [],
          failed: ['（文件句柄不可用）'],
        }
        if (failed.length > 0) {
          setNotice(`保存失败：${failed.join('、')}，已中止操作。`)
          return false
        }
      }
      return true
    },
    [],
  )

  const guardedResetWorkspaceFiles = useCallback(async (): Promise<boolean> => {
    const { dirtyPaths } = latest.current
    const ok = await guardDirtyBuffersThen({
      message: `切换项目将关闭 ${dirtyPaths.size} 个已修改文件，未保存的修改将丢失。`,
      confirmLabel: '保存全部并切换',
      tertiaryLabel: '放弃修改并切换',
    })
    if (!ok) return false
    // await 之后重新读取最新身份，避免用过期的 resetWorkspaceFiles 闭包。
    latest.current.resetWorkspaceFiles()
    return true
  }, [guardDirtyBuffersThen])

  // 关窗口拦截：脏文件存在时阻止默认关闭，弹窗确认后 destroy。
  // 挂载时接线一次，回调经 latest-ref 读当轮闭包（性能纪律）。
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const { dirtyPaths, confirmAction } = latest.current
        if (dirtyPaths.size === 0) return
        event.preventDefault()
        const result = await confirmAction({
          title: '有未保存的修改',
          message: `有 ${dirtyPaths.size} 个文件未保存，退出后将丢失。`,
          confirmLabel: '放弃修改并退出',
          danger: true,
        })
        if (result === 'cancel') return
        await getCurrentWindow().destroy()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return {
    requestCloseTab,
    guardDirtyBuffersThen,
    guardedResetWorkspaceFiles,
  }
}
