/**
 * 富预览增量加载 hook：首批渲染 → 触底（IntersectionObserver 预取
 * 600px）经 readFile(offset) 追加下一批。分块由 md-chunks 的
 * fence-aware 状态机完成（跨批保持围栏与列表连续性）；总行数硬上限
 * 与追加失败都会置 exhausted 停止加载（已加载块保留）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readFile } from '../../../api/workspace'
import {
  createMdChunkerState,
  feedMdLines,
  flushMdChunks,
  type MdChunkerState,
} from './md-chunks'
import {
  MD_PREVIEW_BATCH_LINES,
  MD_PREVIEW_FIRST_BATCH_LINES,
  MD_PREVIEW_MAX_LINES,
} from './preview'

/** 增量加载状态（一次 setState，避免字段错位）。 */
export interface PreviewFeed {
  /** 已完成的顶层块（只增不减，配合块级 memo 增量渲染）。 */
  blocks: string[]
  /** 未完块行 + 围栏状态（有状态机，随追加演进；见 md-chunks）。 */
  chunker: MdChunkerState
  /** 下一批读取的 0-based 起始行号。 */
  nextLine: number
  totalLines: number
  exhausted: boolean
  capReached: boolean
}

export function useMdIncrementalFeed(
  projectId: string,
  path: string,
  reloadTick: number,
): {
  feed: PreviewFeed | null
  loading: boolean
  error: string | null
  loadingMore: boolean
  loadMore: () => Promise<void>
  sentinelRef: React.RefObject<HTMLDivElement | null>
} {
  const [feed, setFeed] = useState<PreviewFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // 加载代次：重置（首批 effect 重跑）时递增；陈旧的追加请求按代次丢弃，
  // 防止在途 setFeed 覆盖重置后的新状态（竞态守卫）。
  const generationRef = useRef(0)

  // 首批加载（reloadTick 变化时重置增量状态重读）。
  useEffect(() => {
    let disposed = false
    generationRef.current += 1
    setLoading(true)
    setError(null)
    setFeed(null)
    void (async () => {
      try {
        const result = await readFile(projectId, path, {
          limit: MD_PREVIEW_FIRST_BATCH_LINES,
        })
        if (disposed) return
        const chunker = createMdChunkerState()
        const lines = result.content === '' ? [] : result.content.split('\n')
        const blocks = feedMdLines(chunker, lines)
        const nextLine = lines.length
        // 空页视为读完：Rust 对单空行文件（"\n"）返回 content='' 但
        // totalLines=1，若不终结会导致同 offset 无限重读（死循环）。
        const exhausted = lines.length === 0 || nextLine >= result.totalLines
        if (exhausted) blocks.push(...flushMdChunks(chunker))
        setFeed({
          blocks,
          chunker,
          nextLine,
          totalLines: result.totalLines,
          exhausted,
          capReached: false,
        })
      } catch (err) {
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
    }
  }, [projectId, path, reloadTick])

  // 触底追加下一批（exhausted 后哨兵不再观察）。
  const loadMore = useCallback(async (): Promise<void> => {
    if (feed === null || feed.exhausted || loadingMore) return
    const generation = generationRef.current
    setLoadingMore(true)
    try {
      const result = await readFile(projectId, path, {
        offset: feed.nextLine,
        limit: MD_PREVIEW_BATCH_LINES,
      })
      if (generationRef.current !== generation) return
      const lines = result.content === '' ? [] : result.content.split('\n')
      const blocks = [...feed.blocks, ...feedMdLines(feed.chunker, lines)]
      const nextLine = feed.nextLine + lines.length
      const capReached = nextLine >= MD_PREVIEW_MAX_LINES
      const exhausted =
        capReached || lines.length === 0 || nextLine >= feed.totalLines
      if (exhausted) blocks.push(...flushMdChunks(feed.chunker))
      setFeed({
        blocks,
        chunker: feed.chunker,
        nextLine,
        totalLines: feed.totalLines,
        exhausted,
        capReached,
      })
    } catch (err) {
      if (generationRef.current !== generation) return
      setError(err instanceof Error ? err.message : String(err))
      setFeed({ ...feed, exhausted: true })
    } finally {
      setLoadingMore(false)
    }
  }, [feed, loadingMore, projectId, path])

  // 增量加载哨兵：feed 变化时重挂观察（事件驱动，无定时器）。
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || feed === null || feed.exhausted || loadingMore) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore()
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
    }
  }, [feed, loadingMore, loadMore])

  return { feed, loading, error, loadingMore, loadMore, sentinelRef }
}
