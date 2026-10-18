import { useEffect, useRef, useState, type RefObject } from 'react'
import { browserSurface } from '../../api/browser'
import { isBrowserViewportBlocked } from './viewport-obstruction'

/** Native overlays cannot be clipped by CSS. Sync the measured slot and hide for dialogs. */
export function useBrowserViewport(
  ref: RefObject<HTMLDivElement | null>,
  visible: boolean,
  available: boolean,
  activeTabId: number | null,
): string | null {
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ visible, available, activeTabId })
  latest.current = { visible, available, activeTabId }
  const requestLayout = useRef<() => void>(() => {})
  useEffect(() => {
    requestLayout.current()
  }, [visible, available, activeTabId])
  useEffect(() => {
    let observedElement: HTMLDivElement | null = null
    let frame: ReturnType<typeof setTimeout> | null = null
    let previous = ''
    let disposed = false
    let pending = false
    let again = false
    const update = async (): Promise<void> => {
      frame = null
      if (disposed || !latest.current.available) return
      if (pending) {
        again = true
        return
      }
      const element = ref.current
      if (element !== observedElement) {
        resize.disconnect()
        if (element) resize.observe(element)
        observedElement = element
      }
      const rect = element?.getBoundingClientRect() ?? new DOMRect()
      const blocked = isBrowserViewportBlocked(rect)
      const action = {
        kind: 'layout' as const,
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        visible:
          latest.current.visible &&
          !blocked &&
          rect.width > 0 &&
          rect.height > 0,
      }
      // A recreated native session needs its frame even when geometry is unchanged.
      const signature = JSON.stringify([action, latest.current.activeTabId])
      if (signature === previous) return
      pending = true
      try {
        await browserSurface.control(action)
        if (!disposed) setError(null)
        previous = signature
      } catch (caught) {
        if (!disposed)
          setError(caught instanceof Error ? caught.message : String(caught))
        previous = ''
      } finally {
        pending = false
        if (again && !disposed) {
          again = false
          schedule()
        }
      }
    }
    const schedule = (): void => {
      if (frame === null && !disposed)
        frame = setTimeout(() => void update(), 16)
    }
    requestLayout.current = schedule
    const resize = new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'open',
        'role',
        'aria-modal',
        'hidden',
        'style',
        'class',
        'data-browser-occluder',
      ],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      disposed = true
      requestLayout.current = () => {}
      if (frame !== null) clearTimeout(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      void browserSurface
        .control({
          kind: 'layout',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
        })
        .catch(() => {})
    }
  }, [ref])
  return error
}
