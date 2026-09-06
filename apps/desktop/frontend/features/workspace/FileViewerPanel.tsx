import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@reflexion-os-studio/runtime-client'
import { FolderIcon } from '../../ui/icons'
import { ContentView } from './ContentView'
import type { OpenFileTab } from './types'

/** 转义 CSS 选择器属性值中的特殊字符，路径可含 `.`、`/` 等。 */
function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}

interface FileViewerPanelProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件读取依赖它。 */
  systemReady: boolean
  /** 已打开的标签（有序，前端保证不重复）。 */
  openTabs: OpenFileTab[]
  /** 当前激活标签的 path；null 表示无激活文件。 */
  activePath: string | null
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  /** 拖拽排序完成后回调：paths 为新的打开顺序。 */
  onReorderTabs: (paths: string[]) => void
  /** 面板宽度（由 App 拖拽控制）。 */
  width?: number
}

/**
 * 对话右侧的文件查看器：多文件顶部标签 + 单个激活文件的只读预览。
 * 标签排序用 pointer events 自绘拖动（不依赖原生 HTML5 DnD——后者在
 * Tauri 各平台 WebView 行为不一致）：按下只登记候选、不捕获指针，
 * 指针移动超过阈值才进入拖动态；被拖标签原位半透明 + 虚线框，插入
 * 指示线实时预览落点，松手一次性提交新顺序；普通点击仍正常派发给
 * 选择/关闭按钮。文件内容只经 workspace.read_file 获取。
 */
export function FileViewerPanel(
  props: FileViewerPanelProps,
): React.JSX.Element {
  const { project } = props
  const activeTab =
    props.openTabs.find((tab) => tab.path === props.activePath) ?? null
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState(false)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [thumbRatio, setThumbRatio] = useState(1)
  const [trackWidth, setTrackWidth] = useState(0)

  // 拖拽排序状态：pendingRef 为按下后的候选拖拽（指针未越过阈值前不进
  // 入拖动态，保证普通点击选择/关闭不受影响）；dragStateRef 为已进入拖
  // 动态的标签与最新插入点；insertLineX 驱动插入指示线渲染。
  const pendingRef = useRef<{
    path: string
    pointerId: number
    startX: number
    startY: number
    el: HTMLElement
  } | null>(null)
  const dragStateRef = useRef<{
    path: string
    pointerId: number
    insertIndex: number
  } | null>(null)
  // 窗口级监听在每次 pointerdown 时登记，供松手/取消后精确移除。
  const windowHandlersRef = useRef<{
    move: (event: PointerEvent) => void
    up: (event: PointerEvent) => void
    cancel: () => void
  } | null>(null)
  const openTabsRef = useRef(props.openTabs)
  openTabsRef.current = props.openTabs
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [insertLineX, setInsertLineX] = useState<number | null>(null)

  // 同步标签容器的横向滚动量，驱动自定义滚动条滑块；窗口/标签变化时重算。
  useEffect(() => {
    const el = tabsScrollRef.current
    if (el === null) return
    const update = (): void => {
      const { scrollLeft, scrollWidth, clientWidth } = el
      const overflow = scrollWidth - clientWidth
      setCanScroll(overflow > 0)
      setThumbRatio(Math.min(1, clientWidth / scrollWidth))
      setScrollRatio(overflow > 0 ? scrollLeft / overflow : 0)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const trackObserver = trackRef.current
      ? new ResizeObserver(() => {
          const width = trackRef.current?.clientWidth ?? 0
          setTrackWidth(width)
        })
      : null
    if (trackObserver !== null)
      trackObserver.observe(trackRef.current as HTMLElement)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
      trackObserver?.disconnect()
    }
  }, [props.openTabs])

  // 点击轨道：跳到点击位置附近；拖动滑块：按比例换算 scrollLeft。
  const handleTrackPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = tabsScrollRef.current
    const track = trackRef.current
    if (el === null || track === null) return
    const trackWidth = track.clientWidth
    const thumbWidth = Math.max(24, trackWidth * thumbRatio)
    const maxScroll = el.scrollWidth - el.clientWidth
    const clickOffset = event.clientX - track.getBoundingClientRect().left
    const startLeft = el.scrollLeft
    const startX = event.clientX

    // 点击轨道但未落在滑块上时直接跳转。
    const onThumb = clickOffset >= 0 && clickOffset <= thumbWidth
    if (!onThumb && maxScroll > 0) {
      el.scrollLeft = (clickOffset / trackWidth) * maxScroll
    }

    const move = (moveEvent: PointerEvent): void => {
      if (maxScroll <= 0) return
      const deltaX = moveEvent.clientX - startX
      const maxDelta = trackWidth - thumbWidth
      const ratio = maxDelta > 0 ? deltaX / maxDelta : 0
      el.scrollLeft = Math.min(
        maxScroll,
        Math.max(0, startLeft + ratio * maxScroll),
      )
    }
    const up = (): void => {
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
      track.removeEventListener('pointercancel', up)
    }
    track.setPointerCapture(event.pointerId)
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)
  }

  // 鼠标滚轮在标签栏上滚动时转换为横向滚动；按住 Shift 或已有横向
  // 增量（触控板）时不拦截，保留原生行为。
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.shiftKey || event.deltaX !== 0) return
    const el = tabsScrollRef.current
    if (el === null) return
    el.scrollLeft += event.deltaY
  }

  // 指针 x 对应的插入点：候选标签（排除被拖标签）中心左侧即插入其前；
  // lineX 为插入指示线在标签行内容坐标系中的位置（渲染 + 边缘自动滚动共用）。
  const computeDrop = (
    x: number,
    path: string,
  ): { index: number; lineX: number } => {
    const el = tabsScrollRef.current
    if (el === null) return { index: 0, lineX: 0 }
    const rest = openTabsRef.current.filter((tab) => tab.path !== path)
    const nodes = rest.map((tab) =>
      el.querySelector<HTMLElement>(`[data-tab-path="${cssEscape(tab.path)}"]`),
    )
    let insertAt = rest.length
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      if (node === null) continue
      const rect = node.getBoundingClientRect()
      if (x < rect.left + rect.width / 2) {
        insertAt = i
        break
      }
    }
    let lineX = 0
    if (insertAt === 0) {
      lineX = nodes[0]?.offsetLeft ?? 0
    } else if (insertAt >= rest.length) {
      const last = nodes[nodes.length - 1]
      lineX = last !== null ? last.offsetLeft + last.offsetWidth : 0
    } else {
      const prev = nodes[insertAt - 1]
      const next = nodes[insertAt]
      lineX =
        prev !== null && next !== null
          ? (prev.offsetLeft + prev.offsetWidth + next.offsetLeft) / 2
          : 0
    }
    return { index: insertAt, lineX }
  }

  // 按最终插入点落定新顺序；与当前顺序一致时不触发回调。
  const commitDrag = (path: string, insertIndex: number): void => {
    const tabs = openTabsRef.current
    const moved = tabs.find((tab) => tab.path === path)
    if (moved === undefined) return
    const next = tabs.filter((tab) => tab.path !== path)
    next.splice(insertIndex, 0, moved)
    const unchanged =
      next.length === tabs.length &&
      next.every((tab, index) => tab.path === tabs[index].path)
    if (!unchanged) props.onReorderTabs(next.map((tab) => tab.path))
  }

  const clearDragHandlers = useCallback((): void => {
    const handlers = windowHandlersRef.current
    if (handlers !== null) {
      window.removeEventListener('pointermove', handlers.move)
      window.removeEventListener('pointerup', handlers.up)
      window.removeEventListener('pointercancel', handlers.cancel)
      windowHandlersRef.current = null
    }
    pendingRef.current = null
    dragStateRef.current = null
    setDragPath(null)
    setInsertLineX(null)
  }, [])

  // 面板卸载时兜底清理窗口级监听，避免拖拽中途卸载导致泄漏。
  useEffect(() => clearDragHandlers, [clearDragHandlers])

  // 标签拖拽排序（pointer events 自绘）：按下只登记候选，不捕获指针、
  // 不 preventDefault——普通点击仍能正常派发 click 到选择/关闭按钮；
  // 窗口级 pointermove 中越过阈值才进入拖动态并捕获指针，拖动中仅更新
  // 插入指示线（标签保持原位），pointerup 提交新顺序，pointercancel 复原。
  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    path: string,
  ): void => {
    // 上次按下若未正常结束（如指针在窗口外松开）会残留候选状态，
    // 先自愈清理再登记本次按下，避免标签永久无法拖拽。
    if (windowHandlersRef.current !== null) clearDragHandlers()
    if (event.button !== 0) return
    const el = event.currentTarget

    const move = (moveEvent: PointerEvent): void => {
      const pending = pendingRef.current
      if (pending === null || moveEvent.pointerId !== pending.pointerId) return
      // 主键已松开却仍收到 move（窗口外松开等）时放弃本次拖拽。
      if ((moveEvent.buttons & 1) === 0) {
        clearDragHandlers()
        return
      }
      if (dragStateRef.current === null) {
        // 移动超过阈值才算拖拽，避免点击时的轻微抖动误触发。
        const dx = moveEvent.clientX - pending.startX
        const dy = moveEvent.clientY - pending.startY
        if (Math.hypot(dx, dy) < 5) return
        moveEvent.preventDefault()
        dragStateRef.current = {
          path: pending.path,
          pointerId: pending.pointerId,
          insertIndex: 0,
        }
        setDragPath(pending.path)
        pending.el.setPointerCapture(pending.pointerId)
      }
      const drop = computeDrop(moveEvent.clientX, pending.path)
      if (dragStateRef.current !== null) {
        dragStateRef.current.insertIndex = drop.index
      }
      setInsertLineX(drop.lineX)
      // 拖到标签行边缘时自动滚动，保证指示线始终可见。
      const scroller = tabsScrollRef.current
      if (scroller !== null && scroller.scrollWidth > scroller.clientWidth) {
        if (drop.lineX < scroller.scrollLeft + 4) {
          scroller.scrollLeft = Math.max(0, drop.lineX - 4)
        } else if (
          drop.lineX >
          scroller.scrollLeft + scroller.clientWidth - 4
        ) {
          scroller.scrollLeft = drop.lineX - scroller.clientWidth + 4
        }
      }
    }

    const up = (upEvent: PointerEvent): void => {
      const pending = pendingRef.current
      const engaged = dragStateRef.current
      if (
        engaged !== null &&
        pending !== null &&
        upEvent.pointerId === engaged.pointerId
      ) {
        commitDrag(engaged.path, engaged.insertIndex)
      }
      clearDragHandlers()
    }

    const cancel = (): void => {
      clearDragHandlers()
    }

    pendingRef.current = {
      path,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      el,
    }
    windowHandlersRef.current = { move, up, cancel }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  if (project === null) {
    return (
      <div className="workspace-panel" style={{ width: props.width }}>
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧选择项目后，可在这里浏览工作区文件。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-panel" style={{ width: props.width }}>
      {props.openTabs.length > 0 ? (
        <>
          <div className="file-tabs" role="tablist" aria-label="已打开文件">
            <div
              className="file-tabs-scroll"
              ref={tabsScrollRef}
              onWheel={handleWheel}
            >
              {dragPath !== null && insertLineX !== null && (
                <div
                  className="file-tabs-drop-line"
                  aria-hidden="true"
                  style={{ transform: `translateX(${insertLineX}px)` }}
                />
              )}
              {props.openTabs.map((tab) => {
                const active = tab.path === props.activePath
                const dragging = tab.path === dragPath
                const fileName = tab.path.split('/').pop() ?? tab.path
                return (
                  <div
                    key={tab.path}
                    data-tab-path={tab.path}
                    className={`file-tab${active ? ' active' : ''}${
                      dragging ? ' dragging' : ''
                    }`}
                    role="tab"
                    aria-selected={active}
                    onPointerDown={(event) =>
                      handleTabPointerDown(event, tab.path)
                    }
                  >
                    <button
                      type="button"
                      className="file-tab-main"
                      title={tab.path}
                      onClick={() => props.onSelectTab(tab.path)}
                    >
                      {fileName}
                    </button>
                    <button
                      type="button"
                      className="file-tab-close"
                      title={`关闭 ${fileName}`}
                      aria-label={`关闭 ${fileName}`}
                      onClick={() => props.onCloseTab(tab.path)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            {/* 始终可见的自定义横向滚动条：有溢出才显示滑块，可点击/拖动 */}
            <div
              className="file-tabs-track"
              ref={trackRef}
              onPointerDown={handleTrackPointerDown}
            >
              {canScroll && trackWidth > 0 && (
                <div
                  className="file-tabs-thumb"
                  style={{
                    width: `${Math.max(24, trackWidth * thumbRatio)}px`,
                    transform: `translateX(${scrollRatio * Math.max(0, trackWidth - 8 - Math.max(24, trackWidth * thumbRatio))}px)`,
                  }}
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧项目文件工作区中选择文件，可在右侧打开预览。</p>
        </div>
      )}

      {!props.systemReady && activeTab !== null && (
        <div className="workspace-degraded">
          工具 Runtime 不可用：文件预览暂不可用。
        </div>
      )}

      {activeTab !== null && (
        <div className="workspace-preview">
          <ContentView
            key={`${activeTab.path}#${activeTab.nonce ?? 0}`}
            projectId={project.id}
            path={activeTab.path}
            initialLine={activeTab.line}
            onClose={() => props.onCloseTab(activeTab.path)}
          />
        </div>
      )}
    </div>
  )
}
