import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditorType } from 'monaco-editor'
import { readFile, writeFile } from '../../../api/workspace'
import { getLanguageForFile, getFileName } from './language'
import { DEFAULT_EDITOR_OPTIONS, THEME_NAME, THEME_DATA } from './monaco'
import type { MonacoEditorProps } from './types'
import { EDITOR_CONFIG } from './types'

/** 只读/编辑切换的 Monaco 单文件编辑器。 */
export function MonacoEditor(props: MonacoEditorProps): React.JSX.Element {
  const { projectId, path, initialLine, readOnly, onClose, onContentChange } =
    props
  const [content, setContent] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(!readOnly)
  const [saving, setSaving] = useState(false)
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null)

  const language = getLanguageForFile(path)
  const fileName = getFileName(path)
  const dirty = content !== null && content !== baseline

  // 加载文件内容
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = await readFile(projectId, path)
        if (disposed) return
        setContent(result.content)
        setBaseline(result.content)
        setEditMode(
          !readOnly &&
            result.sizeBytes < EDITOR_CONFIG.EDIT_READ_ONLY_THRESHOLD,
        )
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

  // 同步 readOnly prop 到 editMode
  useEffect(() => {
    if (readOnly) setEditMode(false)
  }, [readOnly])

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

  const handleSave = useCallback(async () => {
    if (content === null || saving) return
    setSaving(true)
    try {
      await writeFile(projectId, path, content)
      setBaseline(content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [content, saving, projectId, path])

  const handleCopy = useCallback(async () => {
    if (content === null) return
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      // 剪贴板不可用时静默失败。
    }
  }, [content])

  if (error && content === null) {
    return (
      <div className="content-view">
        <header className="content-head">
          <button
            className="ghost content-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
          <span className="content-name">{fileName}</span>
        </header>
        <div className="content-error">{error}</div>
      </div>
    )
  }

  return (
    <div className="content-view monaco-editor-container">
      <header className="content-head">
        <button
          className="ghost content-close"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          ×
        </button>
        <span className="content-name" title={path}>
          {fileName}
        </span>
        <button
          className="ghost"
          onClick={() => void handleCopy()}
          title="复制全文"
        >
          复制
        </button>
        {!readOnly && (
          <>
            <button
              className={`ghost${editMode ? ' active' : ''}`}
              onClick={() => setEditMode((v) => !v)}
              title={editMode ? '切换为只读' : '切换为编辑'}
            >
              {editMode ? '编辑中' : '只读'}
            </button>
            {dirty && (
              <button
                className="ghost"
                onClick={() => void handleSave()}
                disabled={saving}
                title="保存"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            )}
          </>
        )}
        {error !== null && (
          <span className="content-error-inline">{error}</span>
        )}
      </header>
      <div className="content-body monaco-body">
        {loading ? (
          <div className="content-hint">加载中…</div>
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
    </div>
  )
}
