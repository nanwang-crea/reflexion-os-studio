import { useEffect, useRef, useState } from 'react'
import type { Project } from '@reflexion-os-studio/runtime-client'
import { FolderIcon } from '../../ui/icons'
import { ContentView } from './ContentView'
import type { OpenFileTab } from './types'

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
  onReorderTabs: (fromPath: string, toPath: string) => void
  /** 面板宽度（由 App 拖拽控制）。 */
  width?: number
}

/**
 * 对话右侧的文件查看器：多文件顶部标签 + 单个激活文件的只读预览。
 * 文件内容只经 workspace.read_file 获取（Rust 侧 workspace 边界校验）。
 * 打开哪个文件由左侧项目文件工作区决定（App 持有 openTabs 状态）。
 */
export function FileViewerPanel(
  props: FileViewerPanelProps,
): React.JSX.Element {
  const { project } = props
  const activeTab =
    props.openTabs.find((tab) => tab.path === props.activePath) ?? null
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const draggedPathRef = useRef<string | null>(null)
  const [canScroll, setCanScroll] = useState(false)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [thumbRatio, setThumbRatio] = useState(1)
  const [trackWidth, setTrackWidth] = useState(0)

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

  // 标签拖拽排序：记录源标签，drop 到目标标签时回调重排（拖到自身忽略）。
  const handleDragStart = (
    event: React.DragEvent<HTMLDivElement>,
    path: string,
  ): void => {
    draggedPathRef.current = path
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', path)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (
    event: React.DragEvent<HTMLDivElement>,
    toPath: string,
  ): void => {
    event.preventDefault()
    const fromPath =
      draggedPathRef.current ?? event.dataTransfer.getData('text/plain')
    if (fromPath === '' || fromPath === toPath) return
    props.onReorderTabs(fromPath, toPath)
    draggedPathRef.current = null
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
              {props.openTabs.map((tab) => {
                const active = tab.path === props.activePath
                const fileName = tab.path.split('/').pop() ?? tab.path
                return (
                  <div
                    key={tab.path}
                    className={`file-tab${active ? ' active' : ''}`}
                    role="tab"
                    aria-selected={active}
                    draggable
                    onDragStart={(event) => handleDragStart(event, tab.path)}
                    onDragOver={handleDragOver}
                    onDrop={(event) => handleDrop(event, tab.path)}
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
