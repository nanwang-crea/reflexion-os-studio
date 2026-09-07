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
  const { projectId, path, oldPath, staged, source, before, after, onClose } =
    props
  const [original, setOriginal] = useState('')
  const [modified, setModified] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const title = oldPath ? `${oldPath} → ${path}` : path
  const language = getLanguageForFile(path)
  const fileName = getFileName(path)

  const loadDiff = useCallback(async () => {
    setLoading(true)
    setError(null)

    // 直接传入 before/after（Chat diff 场景）
    if (before !== undefined || after !== undefined) {
      setOriginal(before ?? '')
      setModified(after ?? '')
      setLoading(false)
      return
    }

    try {
      const result = await gitDiff(projectId, path, staged)
      if (!result.repo) {
        setError('当前目录不是 Git 仓库')
        setLoading(false)
        return
      }
      // 解析 unified diff 提取原始/修改内容
      const { orig, mod } = parseUnifiedDiff(result.diff)
      setOriginal(orig)
      setModified(mod)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [projectId, path, staged, before, after])

  useEffect(() => {
    void loadDiff()
  }, [loadDiff])

  const handleMount: DiffOnMount = useCallback((_editor, monaco) => {
    monaco.editor.defineTheme(THEME_NAME, THEME_DATA)
    monaco.editor.setTheme(THEME_NAME)
  }, [])

  const headerTitle =
    source === 'chat' ? '本次编辑' : staged ? '暂存区' : '工作区'

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

/** 解析 unified diff 文本，提取原始/修改内容。 */
function parseUnifiedDiff(diff: string): {
  orig: string
  mod: string
} {
  const origLines: string[] = []
  const modLines: string[] = []

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) continue
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    )
      continue

    if (line.startsWith('+')) {
      modLines.push(line.slice(1))
    } else if (line.startsWith('-')) {
      origLines.push(line.slice(1))
    } else if (line.startsWith(' ')) {
      const text = line.slice(1)
      origLines.push(text)
      modLines.push(text)
    }
  }

  return { orig: origLines.join('\n'), mod: modLines.join('\n') }
}
