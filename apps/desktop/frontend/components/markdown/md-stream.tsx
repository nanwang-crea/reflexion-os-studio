/**
 * 流式 Markdown 分块渲染（性能 P0）：把已完成的顶层块各自解析一次并缓存
 * React 元素，每次 16ms flush 只重建仍在增长的尾块。缓存以"head 是上一轮
 * head 的前缀扩展"判定有效，文本被替换或回退时整体重置。
 */
import { useMemo, useRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMarkdownBlocks, splitStreamingMarkdown } from './md-blocks'
import {
  rehypeStreamCaret,
  rehypeStreamRevealBlock,
  urlTransform,
} from './md-hast'

interface BlockCache {
  components: Components | null
  /** 已解析进 nodes 的 head 文本（下一轮必须是它的前缀扩展）。 */
  source: string
  nodes: ReactNode[]
  nextKey: number
}

export function StreamedMarkdown(props: {
  text: string
  components: Components
}): React.JSX.Element {
  const cacheRef = useRef<BlockCache>({
    components: null,
    source: '',
    nodes: [],
    nextKey: 0,
  })
  const { nodes, tail } = useMemo(() => {
    const split = splitStreamingMarkdown(props.text)
    const cache = cacheRef.current
    const usable =
      cache.components === props.components &&
      split.head.length >= cache.source.length &&
      split.head.startsWith(cache.source)
    if (!usable) {
      cache.components = props.components
      cache.source = ''
      cache.nodes = []
      cache.nextKey = 0
    }
    if (split.head.length > cache.source.length) {
      const addition = split.head.slice(cache.source.length)
      for (const block of splitMarkdownBlocks(addition)) {
        cache.nodes.push(
          <ReactMarkdown
            key={`md-block-${cache.nextKey}`}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeStreamRevealBlock]}
            urlTransform={urlTransform}
            components={props.components}
          >
            {block}
          </ReactMarkdown>,
        )
        cache.nextKey += 1
      }
      cache.source = split.head
    }
    return { nodes: cache.nodes, tail: split.tail }
  }, [props.text, props.components])

  return (
    <>
      {nodes}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeStreamCaret]}
        urlTransform={urlTransform}
        components={props.components}
      >
        {tail}
      </ReactMarkdown>
    </>
  )
}
