import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, WheelEvent } from 'react'

/** Follow layout changes until the user deliberately scrolls away. */
export function useTranscriptFollow(
  scrollRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
) {
  const [pinned, setPinned] = useState(true)
  const position = useRef({ top: 0, height: 0, viewport: 0 })
  const recordPosition = useCallback((): void => {
    const el = scrollRef.current
    if (el)
      position.current = {
        top: el.scrollTop,
        height: el.scrollHeight,
        viewport: el.clientHeight,
      }
  }, [scrollRef])
  const pause = useCallback((): void => setPinned(false), [])
  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>): void => {
      if (event.deltaY < 0 && event.currentTarget.scrollTop > 0) pause()
    },
    [pause],
  )
  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const previous = position.current
    // Native clamping after collapse/resize is not a user scrolling upward.
    const layoutChanged =
      previous.height !== el.scrollHeight ||
      previous.viewport !== el.clientHeight
    if (!layoutChanged && el.scrollTop !== previous.top) {
      const movingUp = el.scrollTop < previous.top
      setPinned(
        !movingUp && el.scrollHeight - el.scrollTop - el.clientHeight < 80,
      )
    }
    recordPosition()
  }, [recordPosition, scrollRef])
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    recordPosition()
    setPinned(true)
  }, [recordPosition, scrollRef])
  useLayoutEffect(scrollToBottom, [sessionId, scrollToBottom])

  return {
    pinned,
    handleScroll,
    handleWheel,
    recordPosition,
    pause,
    scrollToBottom,
  }
}
