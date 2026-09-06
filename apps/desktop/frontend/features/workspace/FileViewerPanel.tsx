import { useEffect, useRef, useState } from 'react'
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
 * 标签排序用 pointer events 自绘拖动（拖过目标标签一半即实时换位，松手落定），
 * 不依赖原生 HTML5 DnD——后者在 Tauri 各平台 WebView 行为不一致。
 * 文件内容只经 workspace.read_file 获取（Rust 侧 workspace 边界校验）。
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

  // 拖拽排序状态：dragPath 为被拖标签；previewTabs 为拖动中的实时顺序。
  const dragPathRef = useRef<string | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [previewTabs, setPreviewTabs] = useState<OpenFileTab[] | null>(null)

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

  // 标签拖拽排序（pointer events 自绘）：
  // pointerdown 记录被拖标签并捕获指针；pointermove 实时按目标标签中心
  // 计算插入位置；pointerup/cancel 提交新顺序。
  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    path: string,
  ): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragPathRef.current = path
    dragPointerIdRef.current = event.pointerId
    setDragPath(path)
    setPreviewTabs(props.openTabs)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleTabPointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const path = dragPathRef.current
    if (path === null) return
    const el = tabsScrollRef.current
    if (el === null) return
    const x = event.clientX
    setPreviewTabs((current) => {
      const base = current ?? props.openTabs
      const moved = base.find((tab) => tab.path === path)
      if (moved === undefined) return base
      const rest = base.filter((tab) => tab.path !== path)
      // 按每个候选标签的横向中心定位插入点：指针越过中心即插入到其后。
      let insertAt = rest.length
      for (let i = 0; i < rest.length; i += 1) {
        const node = el.querySelector<HTMLElement>(
          `[data-tab-path="${cssEscape(rest[i].path)}"]`,
        )
        if (node === null) continue
        const rect = node.getBoundingClientRect()
        if (x < rect.left + rect.width / 2) {
          insertAt = i
          break
        }
      }
      const next = rest.slice()
      next.splice(insertAt, 0, moved)
      return next
    })
  }

  const handleTabPointerUp = (): void => {
    const path = dragPathRef.current
    if (path === null) return
    const id = dragPointerIdRef.current
    dragPathRef.current = null
    dragPointerIdRef.current = null
    setPreviewTabs((current) => {
      const ordered = current ?? props.openTabs
      if (current !== null) props.onReorderTabs(ordered.map((tab) => tab.path))
      return null
    })
    setDragPath(null)
    if (id !== null) {
      const el = tabsScrollRef.current
      el?.releasePointerCapture(id)
    }
  }

  const handleTabPointerCancel = (): void => {
    const id = dragPointerIdRef.current
    dragPathRef.current = null
    dragPointerIdRef.current = null
    setPreviewTabs(null)
    setDragPath(null)
    if (id !== null) {
      const el = tabsScrollRef.current
      el?.releasePointerCapture(id)
    }
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

  const renderTabs = previewTabs ?? props.openTabs

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
              {renderTabs.map((tab) => {
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
                    onPointerMove={handleTabPointerMove}
                    onPointerUp={handleTabPointerUp}
                    onPointerCancel={handleTabPointerCancel}
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
