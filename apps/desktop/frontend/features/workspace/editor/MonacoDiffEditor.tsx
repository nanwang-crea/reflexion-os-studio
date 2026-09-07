import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { DiffOnMount } from '@monaco-editor/react'
import { gitDiff, readFile } from '../../../api/workspace'
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

      if (!result.diff || result.diff.trim() === '') {
        setOriginal('')
        setModified('')
        setLoading(false)
        return
      }

      // 获取当前文件内容（modified）
      const currentFile = await readFile(projectId, path)
      const modifiedContent = currentFile.content

      // 通过反向应用 diff 重建原始内容
      const originalContent = reverseDiff(result.diff, modifiedContent)

      setOriginal(originalContent)
      setModified(modifiedContent)
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

interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: Array<{ type: '+' | '-' | ' '; content: string }>
  contextLineCount: number
}

/** 解析 unified diff 为结构化 hunks。 */
function parseHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  const lines = diff.split('\n')
  let current: DiffHunk | null = null

  for (const line of lines) {
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch) {
      if (current) hunks.push(current)
      current = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
        contextLineCount: 0,
      }
      continue
    }
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    )
      continue

    if (!current) continue

    if (line.startsWith('+')) {
      current.lines.push({ type: '+', content: line.slice(1) })
    } else if (line.startsWith('-')) {
      current.lines.push({ type: '-', content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: ' ', content: line.slice(1) })
      current.contextLineCount++
    }
  }
  if (current) hunks.push(current)
  return hunks
}

/** 在 modified 内容中定位 hunk 的起始行号。 */
function findHunkStart(modLines: string[], hunk: DiffHunk): number {
  const firstContext = hunk.lines.find((l) => l.type === ' ')
  if (!firstContext) return -1

  const searchStart = Math.max(0, hunk.newStart - 10)
  const searchEnd = Math.min(modLines.length, hunk.newStart + 20)

  for (let i = searchStart; i < searchEnd; i++) {
    if (modLines[i] === firstContext.content) {
      let match = true
      let ctxIdx = 0
      for (const line of hunk.lines) {
        if (line.type === ' ') {
          if (modLines[i + ctxIdx] !== line.content) {
            match = false
            break
          }
          ctxIdx++
        }
      }
      if (match) return i
    }
  }
  return -1
}

/**
 * 反向应用 unified diff 到 modified 内容，重建 original 内容。
 * 对每个 hunk，在 modified 中定位并用 removed 行替换 added 行。
 */
function reverseDiff(diff: string, modifiedContent: string): string {
  const hunks = parseHunks(diff)
  if (hunks.length === 0) return modifiedContent

  const modLines = modifiedContent.split('\n')

  // 逆序处理 hunks 以保持行号稳定
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i]
    const startPos = findHunkStart(modLines, hunk)
    if (startPos === -1) continue

    const replacement: string[] = []
    for (const line of hunk.lines) {
      if (line.type === ' ' || line.type === '-') {
        replacement.push(line.content)
      }
      // '+' 行在 modified 中存在但不在 original 中，跳过
    }

    // 计算 hunk 在 modified 中占据的行数（context + added）
    let spanLength = 0
    for (const line of hunk.lines) {
      if (line.type === ' ' || line.type === '+') spanLength++
    }

    modLines.splice(startPos, spanLength, ...replacement)
  }

  return modLines.join('\n')
}
