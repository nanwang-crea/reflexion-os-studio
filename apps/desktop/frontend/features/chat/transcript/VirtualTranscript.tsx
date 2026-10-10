import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject, ReactNode } from 'react'
import type { ChatBlock } from '../chat-blocks'
import { buildOffsets, anchoredTop, visibleRange } from './virtual-layout'

interface Props {
  blocks: ChatBlock[]
  scrollRef: RefObject<HTMLDivElement | null>
  pinned: boolean
  renderBlock: (block: ChatBlock) => ReactNode
}

function MeasuredRow({
  id,
  measure,
  children,
  width,
}: {
  id: string
  width: number
  measure: (id: string, height: number) => void
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => measure(id, el.getBoundingClientRect().height)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, measure, width])
  return (
    <div ref={ref} className="transcript-row" data-block-id={id}>
      {children}
    </div>
  )
}

/** Only visible blocks are mounted; spacers retain measured offscreen heights. */
export function VirtualTranscript({
  blocks,
  scrollRef,
  pinned,
  renderBlock,
}: Props): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [heights, setHeights] = useState(new Map<string, number>())
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0 })
  const keys = useMemo(
    () =>
      blocks.map((block) =>
        block.kind === 'run' ? block.runId : block.item.message.id,
      ),
    [blocks],
  )
  const offsets = useMemo(() => buildOffsets(keys, heights), [keys, heights])
  const total = offsets.at(-1) ?? 0
  const previous = useRef<{
    keys: string[]
    offsets: number[]
    origin: number
    top: number
  } | null>(null)

  // Resolve the anchor before selecting rows, so prepending history never
  // temporarily unmounts the message the user is reading.
  const old = previous.current
  const top = pinned
    ? Math.max(0, total - viewport.height)
    : old
      ? anchoredTop(old.keys, old.offsets, keys, offsets, old.top)
      : viewport.top
  const [start, end] = visibleRange(offsets, top, viewport.height)

  const listTop = useCallback((): number => {
    const container = scrollRef.current
    const list = listRef.current
    if (!container || !list) return 0
    return (
      list.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop
    )
  }, [scrollRef])
  const measure = useCallback((id: string, height: number): void => {
    setHeights((current) => {
      if (Math.abs((current.get(id) ?? -1) - height) < 1) return current
      return new Map(current).set(id, height)
    })
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (pinned) container.scrollTop = container.scrollHeight
    else container.scrollTop = listTop() + top
    previous.current = {
      keys,
      offsets,
      origin: listTop(),
      top: Math.max(0, container.scrollTop - listTop()),
    }
    setViewport({
      top: Math.max(0, container.scrollTop - listTop()),
      height: container.clientHeight,
      width: container.clientWidth,
    })
  }, [keys, offsets, pinned, top, listTop, scrollRef])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let frame = 0
    const update = (): void => {
      // Capture scroll input immediately, before a measurement render can
      // replace spacers and the browser clamps scrollTop to the new height.
      const snapshot = previous.current
      if (snapshot)
        snapshot.top = Math.max(0, container.scrollTop - snapshot.origin)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setViewport({
          top: Math.max(0, container.scrollTop - listTop()),
          height: container.clientHeight,
          width: container.clientWidth,
        })
      })
    }
    let width = container.clientWidth
    const observer = new ResizeObserver(() => {
      if (width !== container.clientWidth) {
        width = container.clientWidth
        setHeights(new Map())
      }
      update()
    })
    observer.observe(container)
    container.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', update)
      cancelAnimationFrame(frame)
    }
  }, [listTop, scrollRef])

  return (
    <div ref={listRef} className="virtual-transcript">
      <div aria-hidden="true" style={{ height: offsets[start] ?? 0 }} />
      {blocks.slice(start, end).map((block, index) => (
        <MeasuredRow
          key={keys[start + index]}
          id={keys[start + index]}
          measure={measure}
          width={viewport.width}
        >
          {renderBlock(block)}
        </MeasuredRow>
      ))}
      <div
        aria-hidden="true"
        style={{ height: total - (offsets[end] ?? total) }}
      />
    </div>
  )
}
