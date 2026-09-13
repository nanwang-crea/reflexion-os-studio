import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { DiffOnMount } from '@monaco-editor/react'
import { gitDiff } from '../../../api/workspace'
import { getLanguageForFile, getFileName } from './language'
import { THEME_NAME, THEME_DATA } from './monaco'
import type { MonacoDiffEditorProps } from './types'

/** 只读 Monaco DiffEditor：展示 Git diff 或 before/after 内容对比。 */
export function MonacoDiffEditor(
  props: MonacoDiffEditorProps,
): React.JSX.Element {
  const {
    projectId,
    path,
    oldPath,
    staged,
    source,
    before,
    after,
    binary: binaryProp,
    truncated: truncatedProp,
    label,
    onClose,
  } = props
  const [original, setOriginal] = useState('')
  const [modified, setModified] = useState('')
  const [loading, setLoading] = useState(true)
  const [binary, setBinary] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const title = oldPath ? `${oldPath} → ${path}` : path
  const language = getLanguageForFile(path)
  const fileName = getFileName(path)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    setError(null)

    // 直接传入 before/after（Chat/历史快照 diff）：binary/truncated 由打开方
    // 决定，props 缺省时重置为 false；不发起 git 请求。
    if (before !== undefined || after !== undefined) {
      setBinary(binaryProp === true)
      setTruncated(truncatedProp === true)
      setOriginal(before ?? '')
      setModified(after ?? '')
      setLoading(false)
      return
    }

    // git 通道：binary/truncated 以 fetch 结果为准，先无条件重置。
    setBinary(false)
    setTruncated(false)
    try {
      const result = await gitDiff(projectId, path, staged)
      if (!result.repo) {
        setError('当前目录不是 Git 仓库')
        setLoading(false)
        return
      }
      setBinary(result.binary)
      setTruncated(result.truncated)
      setOriginal(result.original)
      setModified(result.modified)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [projectId, path, staged, before, after, binaryProp, truncatedProp])

  useEffect(() => {
    void loadDiff()
  }, [loadDiff])

  const handleMount: DiffOnMount = useCallback((_editor, monaco) => {
    monaco.editor.defineTheme(THEME_NAME, THEME_DATA)
    monaco.editor.setTheme(THEME_NAME)
  }, [])

  const headerTitle =
    label ?? (source === 'chat' ? '本次编辑' : staged ? '暂存区' : '工作区')

  return (
    <div className="content-view monaco-editor-container">
      <header className="content-head">
        <button
          className="ghost content-close"
          onClick={onClose}
          aria-label="关闭 Diff"
          title="关闭 Diff"
        >
          ×
        </button>
        <span className="content-name" title={title}>
          {fileName}
        </span>
        <span className="diff-mode">{headerTitle}</span>
        {truncated && <span className="diff-mode">内容过长已截断</span>}
        <button
          className="ghost"
          onClick={() => void loadDiff()}
          title="刷新 Diff"
        >
          刷新
        </button>
      </header>
      <div className="content-body monaco-body">
        {loading ? (
          <div className="content-hint">加载 Diff…</div>
        ) : error !== null ? (
          <div className="content-error">{error}</div>
        ) : binary ? (
          <div className="content-hint">二进制文件，暂不支持对比显示。</div>
        ) : original === modified ? (
          <div className="content-hint">没有可显示的变更。</div>
        ) : (
          <DiffEditor
            original={original}
            modified={modified}
            language={language}
            theme={THEME_NAME}
            options={{
              readOnly: true,
              renderSideBySide: true,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              fontSize: 13,
              minimap: { enabled: false },
            }}
            onMount={handleMount}
            className="monaco-editor-instance"
          />
        )}
      </div>
    </div>
  )
}
