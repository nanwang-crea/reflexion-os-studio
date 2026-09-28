/**
 * 文件标签条：多文件顶部标签 + 拖拽排序 + 原生横向滚动 + 脏圆点。
 * 拖拽用 pointer events 自绘（不依赖原生 HTML5 DnD——后者在 Tauri 各平台
 * WebView 行为不一致）：按下只登记候选、不捕获指针，移动超过阈值才进入
 * 拖动态；被拖标签原位半透明 + 虚线框，插入指示线实时预览落点，松手一次
 * 性提交新顺序。脏标签以圆点替代关闭 ×，hover 时圆点变回 ×（VS Code 行为）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFileTab } from '../types'
import { tabIdOf } from '../types'

/** 转义 CSS 选择器属性值中的特殊字符，tabId 可含 `.`、`/`、`#` 等。 */
function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}

interface FileTabsProps {
  openTabs: OpenFileTab[]
  /** 当前激活标签的 tabId（content=path / diff=path#diff）。 */
  activeTabId: string | null
  /** 已修改未保存的文件路径集合（按 path 键控，仅 content 标签会脏）。 */
  dirtyPaths: Set<string>
  /** 以下回调一律携带 tabId 而非 path。 */
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  /** 拖拽排序完成后回调：ids 为新的 tabId 打开顺序。 */
  onReorderTabs: (ids: string[]) => void
}

export function FileTabs(props: FileTabsProps): React.JSX.Element {
  const tabsScrollRef = useRef<HTMLDivElement>(null)

  const pendingRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    el: HTMLElement
  } | null>(null)
  const dragStateRef = useRef<{
    id: string
    pointerId: number
    insertIndex: number
  } | null>(null)
  const windowHandlersRef = useRef<{
    move: (event: PointerEvent) => void
    up: (event: PointerEvent) => void
    cancel: () => void
  } | null>(null)
  const openTabsRef = useRef(props.openTabs)
  openTabsRef.current = props.openTabs
  const [dragId, setDragId] = useState<string | null>(null)
  const [insertLineX, setInsertLineX] = useState<number | null>(null)

  // 激活标签始终保持可见；横向滚动交给触控板/Shift+滚轮的原生行为。
  useEffect(() => {
    const scroller = tabsScrollRef.current
    const active = scroller?.querySelector<HTMLElement>('.file-tab.active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.activeTabId, props.openTabs])

  const computeDrop = (
    x: number,
    id: string,
  ): { index: number; lineX: number } => {
    const el = tabsScrollRef.current
    if (el === null) return { index: 0, lineX: 0 }
    const rest = openTabsRef.current.filter((tab) => tabIdOf(tab) !== id)
    const nodes = rest.map((tab) =>
      el.querySelector<HTMLElement>(
        `[data-tab-path="${cssEscape(tabIdOf(tab))}"]`,
      ),
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

  const commitDrag = (id: string, insertIndex: number): void => {
    const tabs = openTabsRef.current
    const moved = tabs.find((tab) => tabIdOf(tab) === id)
    if (moved === undefined) return
    const next = tabs.filter((tab) => tabIdOf(tab) !== id)
    next.splice(insertIndex, 0, moved)
    const unchanged =
      next.length === tabs.length &&
      next.every((tab, index) => tabIdOf(tab) === tabIdOf(tabs[index]))
    if (!unchanged) props.onReorderTabs(next.map(tabIdOf))
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
    setDragId(null)
    setInsertLineX(null)
  }, [])

  useEffect(() => clearDragHandlers, [clearDragHandlers])

  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    id: string,
  ): void => {
    if (windowHandlersRef.current !== null) clearDragHandlers()
    if (event.button !== 0) return
    const el = event.currentTarget

    const move = (moveEvent: PointerEvent): void => {
      const pending = pendingRef.current
      if (pending === null || moveEvent.pointerId !== pending.pointerId) return
      if ((moveEvent.buttons & 1) === 0) {
        clearDragHandlers()
        return
      }
      if (dragStateRef.current === null) {
        const dx = moveEvent.clientX - pending.startX
        const dy = moveEvent.clientY - pending.startY
        if (Math.hypot(dx, dy) < 5) return
        moveEvent.preventDefault()
        dragStateRef.current = {
          id: pending.id,
          pointerId: pending.pointerId,
          insertIndex: 0,
        }
        setDragId(pending.id)
        pending.el.setPointerCapture(pending.pointerId)
      }
      const drop = computeDrop(moveEvent.clientX, pending.id)
      if (dragStateRef.current !== null) {
        dragStateRef.current.insertIndex = drop.index
      }
      setInsertLineX(drop.lineX)
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
        commitDrag(engaged.id, engaged.insertIndex)
      }
      clearDragHandlers()
    }

    const cancel = (): void => {
      clearDragHandlers()
    }

    pendingRef.current = {
      id,
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

  return (
    <div className="file-tabs" role="tablist" aria-label="已打开文件">
      <div className="file-tabs-scroll" ref={tabsScrollRef}>
        {dragId !== null && insertLineX !== null && (
          <div
            className="file-tabs-drop-line"
            aria-hidden="true"
            style={{ transform: `translateX(${insertLineX}px)` }}
          />
        )}
        {props.openTabs.map((tab) => {
          const id = tabIdOf(tab)
          const active = id === props.activeTabId
          const dragging = id === dragId
          // 脏圆点按 path 键控且仅 content 标签会脏：diff 标签不得显示圆点。
          const dirty = tab.mode !== 'diff' && props.dirtyPaths.has(tab.path)
          const fileName = tab.path.split('/').pop() ?? tab.path
          return (
            <div
              key={id}
              data-tab-path={id}
              className={`file-tab${active ? ' active' : ''}${
                dragging ? ' dragging' : ''
              }${dirty ? ' dirty' : ''}`}
              role="tab"
              aria-selected={active}
              onPointerDown={(event) => handleTabPointerDown(event, id)}
            >
              <button
                type="button"
                className="file-tab-main"
                title={tab.path}
                onClick={() => props.onSelectTab(id)}
              >
                {fileName}
              </button>
              {dirty && <span className="file-tab-dirty" aria-hidden="true" />}
              <button
                type="button"
                className="file-tab-close"
                title={`关闭 ${fileName}`}
                aria-label={`关闭 ${fileName}`}
                onClick={() => props.onCloseTab(id)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
