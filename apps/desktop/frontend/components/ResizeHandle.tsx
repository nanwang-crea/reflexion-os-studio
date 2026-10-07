import { useRef, useState } from 'react'

interface ResizeHandleProps {
  /** 向右拖动时宽度增量回调；右侧面板用 onResize(width - delta) 变窄。 */
  onResize: (delta: number, currentWidth: number) => void
  resizeSide?: 'previous' | 'next'
}

/** 可拖拽分栏分隔条：按住拖动调整相邻面板宽度（pointer capture）。 */
export function ResizeHandle(props: ResizeHandleProps): React.JSX.Element {
  const draggingRef = useRef(false)
  const lastXRef = useRef(0)
  const [dragging, setDragging] = useState(false)

  const stopDragging = (): void => {
    draggingRef.current = false
    setDragging(false)
  }

  const resize = (handle: HTMLDivElement, delta: number): void => {
    const panel =
      props.resizeSide === 'next'
        ? handle.nextElementSibling
        : handle.previousElementSibling
    if (panel) props.onResize(delta, panel.getBoundingClientRect().width)
  }

  return (
    <div
      className={`resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault()
        draggingRef.current = true
        setDragging(true)
        lastXRef.current = event.clientX
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return
        const delta = event.clientX - lastXRef.current
        lastXRef.current = event.clientX
        resize(event.currentTarget, delta)
      }}
      onPointerUp={(event) => {
        if (!draggingRef.current) return
        stopDragging()
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={(event) => {
        stopDragging()
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={stopDragging}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        resize(event.currentTarget, event.key === 'ArrowRight' ? 12 : -12)
      }}
    />
  )
}
