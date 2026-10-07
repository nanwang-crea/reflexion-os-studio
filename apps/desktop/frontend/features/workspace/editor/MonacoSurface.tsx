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
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import {
  readFile,
  unwatchDir,
  watchDir,
  writeFile,
} from '../../../api/workspace'
import { transport } from '../../../lib/transport'
import { getLanguageForFile } from './language'
import { DEFAULT_EDITOR_OPTIONS, THEME_NAME, THEME_DATA } from './monaco'
import { EDITOR_CONFIG } from './types'
import { normalizeLineEndings, preserveLineEndings } from './file-format'
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
  /** 成功写入磁盘后递增，供宿主显示短暂保存反馈。 */
  saveVersion: number
  /** 文件在磁盘上已变化，当前草稿需要用户决定是否重新加载。 */
  externalChanged: boolean
  /** 干净缓冲区因磁盘变化自动重载后递增。 */
  externalReloadVersion: number
  /** 是否允许编辑（外部只读 / 大小超限 / 截断守卫命中时为 false）。 */
  canEdit: boolean
  editMode: boolean
}

export interface MonacoSurfaceHandle {
  save: () => Promise<boolean>
  discardChanges: () => void
  reloadFromDisk: () => void
  setEditMode: (editMode: boolean) => void
  copyText: () => Promise<void>
}

export interface MonacoSurfaceProps {
  projectId: string
  path: string
  initialLine?: number
  initialLineNonce?: number
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
    a.saveVersion === b.saveVersion &&
    a.externalChanged === b.externalChanged &&
    a.externalReloadVersion === b.externalReloadVersion &&
    a.canEdit === b.canEdit &&
    a.editMode === b.editMode
  )
}

export function MonacoSurface(props: MonacoSurfaceProps): React.JSX.Element {
  const {
    projectId,
    path,
    initialLine,
    initialLineNonce,
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
  const [saveVersion, setSaveVersion] = useState(0)
  const [externalChanged, setExternalChanged] = useState(false)
  const [externalReloadVersion, setExternalReloadVersion] = useState(0)
  const [reloadVersion, setReloadVersion] = useState(0)
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)
  // 保留本次加载的格式基准，保存后撤销删除仍可恢复被删行的原始分隔符。
  const readTokenRef = useRef<string | undefined>(undefined)
  const formatSourceRef = useRef('')
  const stateRef = useRef<MonacoSurfaceState | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const ignoreChangesUntilRef = useRef(0)

  const dirty =
    content !== null &&
    normalizeLineEndings(content) !== normalizeLineEndings(baseline)
  dirtyRef.current = dirty
  const language = getLanguageForFile(path)

  // 加载文件内容；重置编辑态（canEdit 按大小/截断守卫判定）。
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    setSaveVersion(0)
    setExternalChanged(false)
    void (async () => {
      try {
        const result = await readFile(projectId, path, {
          limit: SURFACE_READ_LIMIT,
        })
        if (disposed) return
        const editable =
          readOnly !== true &&
          result.sizeBytes < EDITOR_CONFIG.EDIT_READ_ONLY_THRESHOLD &&
          result.readComplete
        setCanEdit(editable)
        setEditMode(editable)
        readTokenRef.current = result.readToken
        formatSourceRef.current = result.content
        setContent(result.content)
        setBaseline(result.content)
        setLoading(false)
      } catch (err) {
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
        if (reloadVersion > 0) setExternalChanged(true)
        setLoading(false)
      }
    })()
    return () => {
      disposed = true
    }
  }, [projectId, path, readOnly, reloadVersion])

  useEffect(() => {
    const directory = parentDirectory(path)
    let watchId: string | null = null
    let disposed = false
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    void watchDir(projectId, directory)
      .then((result) => {
        if (disposed) void unwatchDir(result.watchId).catch(() => {})
        else watchId = result.watchId
      })
      .catch(() => {})
    const unlisten = transport.onEvent((event: RuntimeEvent) => {
      if (
        event.type !== 'workspace.changed' ||
        event.projectId !== projectId ||
        event.path !== path ||
        savingRef.current ||
        Date.now() < ignoreChangesUntilRef.current
      ) {
        return
      }
      if (reloadTimer !== null) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        if (dirtyRef.current) setExternalChanged(true)
        else {
          setExternalReloadVersion((version) => version + 1)
          setReloadVersion((version) => version + 1)
        }
      }, 120)
    })
    return () => {
      disposed = true
      unlisten()
      if (reloadTimer !== null) clearTimeout(reloadTimer)
      if (watchId !== null) void unwatchDir(watchId).catch(() => {})
    }
  }, [path, projectId])

  // 定位到目标行
  useEffect(() => {
    if (initialLine === undefined) return
    const editor = editorRef.current
    if (editor) {
      editor.revealLineInCenter(initialLine)
      editor.setPosition({ lineNumber: initialLine, column: 1 })
    }
  }, [initialLine, initialLineNonce, loading])

  // 状态上抛（去重，避免宿主随键击重渲染）。
  useEffect(() => {
    if (onStateChange === undefined) return
    const next: MonacoSurfaceState = {
      loading,
      error,
      dirty,
      saving,
      saveVersion,
      externalChanged,
      externalReloadVersion,
      canEdit,
      editMode,
    }
    const prev = stateRef.current
    if (prev !== null && sameState(prev, next)) return
    stateRef.current = next
    onStateChange(next)
  }, [
    loading,
    error,
    dirty,
    saving,
    saveVersion,
    externalChanged,
    externalReloadVersion,
    canEdit,
    editMode,
    onStateChange,
  ])

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      // Monaco 默认 getValue() 不带 BOM；原文件含 BOM 时也应保留。
      const originalBom = baseline.startsWith('\uFEFF')
      const next =
        originalBom && !value.startsWith('\uFEFF') ? `\uFEFF${value}` : value
      setContent(next)
      onContentChange?.(next)
    },
    [onContentChange, baseline],
  )

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (content === null || savingRef.current || !canEdit) return false
    // 内容未变化视为保存成功：Cmd+S 不触发对磁盘的无意义写入。
    if (normalizeLineEndings(content) === normalizeLineEndings(baseline))
      return true
    setSaving(true)
    savingRef.current = true
    setError(null)
    ignoreChangesUntilRef.current = Date.now() + 800
    try {
      const savedContent = preserveLineEndings(
        formatSourceRef.current,
        content,
        baseline,
      )
      if (readTokenRef.current === undefined)
        throw new Error('读取快照不可用，请重新加载后保存。')
      const result = await writeFile(
        projectId,
        path,
        savedContent,
        readTokenRef.current,
      )
      readTokenRef.current = result.readToken
      setBaseline(savedContent)
      setSaveVersion((version) => version + 1)
      setExternalChanged(false)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (isRevisionConflict(message)) setExternalChanged(true)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [content, baseline, canEdit, projectId, path])

  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monaco.editor.defineTheme(THEME_NAME, THEME_DATA)
    monaco.editor.setTheme(THEME_NAME)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSaveRef.current()
    })
  }, [])

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
      discardChanges: (): void => {
        setContent(baseline)
        onContentChange?.(baseline)
      },
      reloadFromDisk: (): void => {
        setReloadVersion((version) => version + 1)
      },
      setEditMode: (next: boolean): void => {
        if (canEdit) setEditMode(next)
      },
      copyText: handleCopy,
    }),
    [handleSave, handleCopy, canEdit, baseline, onContentChange],
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

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index) || '.'
}

function isRevisionConflict(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('stale_revision') ||
    normalized.includes('revision conflict') ||
    normalized.includes('file changed since last read')
  )
}
