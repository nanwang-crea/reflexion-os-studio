import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readFile } from '../../api/workspace'
import { CheckIcon, CopyIcon, EyeIcon } from '../../ui/icons'
import { MessageMarkdown } from '../../components/MessageMarkdown'

const PAGE_LINES = 2000
const LINE_HEIGHT_PX = 20

interface ContentViewProps {
  projectId: string
  path: string
  onClose: () => void
}

interface DocumentState {
  lines: string[]
  offset: number
  totalLines: number
  sizeBytes: number
  loading: boolean
  error: string | null
}

/**
 * 只读代码/文档查看器：行号、复制、跳转行、分段加载（>2000 行时翻页），
 * Markdown / JSON 走预览渲染，其余按文本展示。内容只经 workspace.read_file
 * 获取（Rust 侧强制 workspace 边界），不能访问任意本地路径。
 */
export function ContentView(props: ContentViewProps): React.JSX.Element {
  const [doc, setDoc] = useState<DocumentState>({
    lines: [],
    offset: 0,
    totalLines: 0,
    sizeBytes: 0,
    loading: true,
    error: null,
  })
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const isMarkdown = /\.(md|markdown)$/i.test(props.path)
  const isJson = /\.json$/i.test(props.path)

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const result = await readFile(
          props.projectId,
          props.path,
          0,
          PAGE_LINES,
        )
        if (disposed) return
        setDoc({
          lines: result.content === '' ? [] : result.content.split('\n'),
          offset: result.offset,
          totalLines: result.totalLines,
          sizeBytes: result.sizeBytes,
          loading: false,
          error: null,
        })
      } catch (error) {
        if (disposed) return
        setDoc((state) => ({
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    })()
    return () => {
      disposed = true
    }
  }, [props.projectId, props.path])

  const loadMore = useCallback(async (): Promise<void> => {
    const nextOffset = doc.offset + doc.lines.length
    try {
      const result = await readFile(
        props.projectId,
        props.path,
        nextOffset,
        PAGE_LINES,
      )
      setDoc((state) => ({
        ...state,
        offset: result.offset,
        lines: state.lines.concat(
          result.content === '' ? [] : result.content.split('\n'),
        ),
      }))
    } catch (error) {
      setDoc((state) => ({
        ...state,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [doc.offset, doc.lines.length, props.path, props.projectId])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(doc.lines.join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板不可用时静默失败。
    }
  }

  const jumpToLine = (lineText: string): void => {
    const line = Number.parseInt(lineText, 10)
    if (!Number.isFinite(line) || line < 1) return
    const el = scrollRef.current
    if (el) el.scrollTop = (line - 1) * LINE_HEIGHT_PX
  }

  const fileName = props.path.split('/').pop() ?? props.path
  const contentText = doc.lines.join('\n')
  const showPreview =
    preview && isMarkdown && doc.lines.length > 0 && doc.error === null
  // JSON 文件自动美化预览（解析失败回退原文）；行号按美化后文本计。
  const prettyLines = useMemo(() => {
    if (!isJson || contentText === '') return null
    try {
      return JSON.stringify(JSON.parse(contentText), null, 2).split('\n')
    } catch {
      return null
    }
  }, [contentText, isJson])
  const displayLines = prettyLines ?? doc.lines
  const headerTitle = `${props.path} · ${doc.sizeBytes} B · ${doc.totalLines} 行${
    doc.lines.length < doc.totalLines ? `（已加载 ${doc.lines.length} 行）` : ''
  }`

  return (
    <div className="content-view">
      <header className="content-head">
        <button
          className="ghost content-close"
          onClick={props.onClose}
          aria-label="返回文件树"
          title="返回文件树"
        >
          ×
        </button>
        <span className="content-name" title={headerTitle}>
          {fileName}
        </span>
        {isMarkdown && (
          <button
            className={`ghost${showPreview ? ' active' : ''}`}
            title={showPreview ? '显示原文' : '预览渲染'}
            onClick={() => setPreview((value) => !value)}
          >
            <EyeIcon />
          </button>
        )}
        <button className="ghost" onClick={() => void copy()} title="复制全文">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
        <form
          className="jump-form"
          onSubmit={(event) => {
            event.preventDefault()
            const input = event.currentTarget.elements.namedItem(
              'line',
            ) as HTMLInputElement
            jumpToLine(input.value)
          }}
        >
          <input name="line" placeholder="行" title="跳转行号（Enter）" />
        </form>
      </header>
      {doc.error !== null ? (
        <div className="content-error">{doc.error}</div>
      ) : (
        <div className="content-body" ref={scrollRef}>
          {showPreview ? (
            <div className="md content-md">
              <MessageMarkdown text={contentText} />
            </div>
          ) : (
            <pre className="content-text">
              {displayLines.map((line, index) => (
                <div className="content-line" key={index}>
                  <span className="content-no">{doc.offset + index + 1}</span>
                  <span className="content-code">{line || ' '}</span>
                </div>
              ))}
              {doc.loading && <div className="content-hint">加载中…</div>}
            </pre>
          )}
        </div>
      )}
      {/* JSON 美化成功后全文已在 textContent 中(prettyLines 基于全文)，
          续页拼装会导致行号漂移,此时隐藏"加载更多"。 */}
      {doc.loading === false &&
        doc.lines.length < doc.totalLines &&
        doc.error === null &&
        prettyLines === null && (
          <div className="content-more">
            <button className="ghost" onClick={() => void loadMore()}>
              加载更多（还有 {doc.totalLines - doc.lines.length} 行）
            </button>
          </div>
        )}
    </div>
  )
}
