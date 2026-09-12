/**
 * 无头 Monaco 单文件编辑内核：加载（行数上限内）、编辑、脏跟踪、保存。
 * 不含头部工具栏，由宿主提供界面——MonacoEditor（完整视图）与
 * MarkdownFilePreview（源码即编辑模式）共用。
 * 截断守卫：实际行数超过本次加载数（含 Rust 侧单次行数钳制）时强制
 * 只读，防止把截断内容写回覆盖全文。
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react'
import Editor from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditorType } from 'monaco-editor'
import { readFile, writeFile } from '../../../api/workspace'
import { getLanguageForFile } from './language'
import { DEFAULT_EDITOR_OPTIONS, THEME_NAME, THEME_DATA } from './monaco'
import { EDITOR_CONFIG } from './types'
import { copyTextToClipboard } from '../../../lib/clipboard'
import { showToast } from '../../../components/Toast'

/** 文件读取行上限（Rust 侧 MAX_READ_LIMIT=10000 会再钳制）。 */
const SURFACE_READ_LIMIT = 50_000

/** 上抛给宿主的编辑内核状态（仅变化时通知）。 */
export interface MonacoSurfaceState {
  loading: boolean
  error: string | null
  dirty: boolean
  saving: boolean
  /** 是否允许编辑（外部只读 / 大小超限 / 截断守卫命中时为 false）。 */
  canEdit: boolean
  editMode: boolean
}

export interface MonacoSurfaceHandle {
  save: () => Promise<void>
  setEditMode: (editMode: boolean) => void
  copyText: () => Promise<void>
}

export interface MonacoSurfaceProps {
  projectId: string
  path: string
  initialLine?: number
  /** 外部强制只读（与大小/截断守卫取与）。 */
  readOnly?: boolean
  /** 编辑内核状态上抛（宿主据此渲染保存/切换按钮）。 */
  onStateChange?: (state: MonacoSurfaceState) => void
  /** 编辑内容变化（透传，宿主可忽略）。 */
  onContentChange?: (content: string) => void
  /** React 19 ref-as-prop：保存/切换/复制句柄。 */
  ref?: Ref<MonacoSurfaceHandle>
}

function sameState(a: MonacoSurfaceState, b: MonacoSurfaceState): boolean {
  return (
    a.loading === b.loading &&
    a.error === b.error &&
    a.dirty === b.dirty &&
    a.saving === b.saving &&
    a.canEdit === b.canEdit &&
    a.editMode === b.editMode
  )
}

export function MonacoSurface(props: MonacoSurfaceProps): React.JSX.Element {
  const {
    projectId,
    path,
    initialLine,
    readOnly,
    onStateChange,
    onContentChange,
  } = props
  const [content, setContent] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  const stateRef = useRef<MonacoSurfaceState | null>(null)

  const dirty = content !== null && content !== baseline
  const language = getLanguageForFile(path)

  // 加载文件内容；重置编辑态（canEdit 按大小/截断守卫判定）。
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = await readFile(projectId, path, {
          limit: SURFACE_READ_LIMIT,
        })
        if (disposed) return
        const loadedLines =
          result.content === '' ? 0 : result.content.split('\n').length
        // 空内容（含 Rust 对单空行文件返回 content='' 的形态）视为完整，
        // 否则会误判截断而错误禁用编辑。
        const editable =
          readOnly !== true &&
          result.sizeBytes < EDITOR_CONFIG.EDIT_READ_ONLY_THRESHOLD &&
          (result.content === '' || loadedLines >= result.totalLines)
        setCanEdit(editable)
        setEditMode(editable)
        setContent(result.content)
        setBaseline(result.content)
        setLoading(false)
      } catch (err) {
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    })()
    return () => {
      disposed = true
    }
  }, [projectId, path, readOnly])

  // 定位到目标行
  useEffect(() => {
    if (initialLine === undefined) return
    const editor = editorRef.current
    if (editor) {
      editor.revealLineInCenter(initialLine)
      editor.setPosition({ lineNumber: initialLine, column: 1 })
    }
  }, [initialLine, loading])

  // 状态上抛（去重，避免宿主随键击重渲染）。
  useEffect(() => {
    if (onStateChange === undefined) return
    const next: MonacoSurfaceState = {
      loading,
      error,
      dirty,
      saving,
      canEdit,
      editMode,
    }
    const prev = stateRef.current
    if (prev !== null && sameState(prev, next)) return
    stateRef.current = next
    onStateChange(next)
  }, [loading, error, dirty, saving, canEdit, editMode, onStateChange])

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monaco.editor.defineTheme(THEME_NAME, THEME_DATA)
    monaco.editor.setTheme(THEME_NAME)
  }, [])

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      setContent(value)
      onContentChange?.(value)
    },
    [onContentChange],
  )

  const handleSave = useCallback(async (): Promise<void> => {
    if (content === null || saving || !canEdit) return
    setSaving(true)
    try {
      await writeFile(projectId, path, content)
      setBaseline(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [content, saving, canEdit, projectId, path])

  const handleCopy = useCallback(async (): Promise<void> => {
    if (content === null) return
    const ok = await copyTextToClipboard(content)
    showToast(
      ok ? '已复制全文到剪贴板' : '复制失败，请重试',
      ok ? 'success' : 'error',
    )
  }, [content])

  useImperativeHandle(
    props.ref,
    () => ({
      save: handleSave,
      setEditMode: (next: boolean): void => {
        if (canEdit) setEditMode(next)
      },
      copyText: handleCopy,
    }),
    [handleSave, handleCopy, canEdit],
  )

  return (
    <div className="monaco-body">
      {loading ? (
        <div className="content-hint">加载中…</div>
      ) : error !== null && content === null ? (
        <div className="content-hint">{error}</div>
      ) : (
        <Editor
          language={language}
          value={content ?? ''}
          theme={THEME_NAME}
          options={{
            ...DEFAULT_EDITOR_OPTIONS,
            readOnly: !editMode,
            domReadOnly: !editMode,
          }}
          onMount={handleEditorMount}
          onChange={handleChange}
          className="monaco-editor-instance"
        />
      )}
    </div>
  )
}
