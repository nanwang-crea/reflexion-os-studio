import { useEffect, useMemo, useState } from 'react'
import { gitDiff } from '../../api/workspace'

interface DiffViewerProps {
  projectId: string
  path: string
  staged?: boolean
  oldPath?: string
  onClose: () => void
}

type DiffRow = { kind: 'context' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string }

function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); continue }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('+')) rows.push({ kind: 'add', newNo: newNo++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) })
    else if (line.startsWith(' ')) rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
  }
  return rows
}

export function DiffViewer(props: DiffViewerProps): React.JSX.Element {
  const [state, setState] = useState<{ diff: string; truncated: boolean; error: string | null; loading: boolean }>({ diff: '', truncated: false, error: null, loading: true })
  const load = (): void => {
    setState((current) => ({ ...current, loading: true, error: null }))
    void gitDiff(props.projectId, props.path, props.staged).then((result) => {
      setState({ diff: result.diff, truncated: result.truncated, error: result.repo ? null : '当前目录不是 Git 仓库', loading: false })
    }).catch((error: unknown) => setState({ diff: '', truncated: false, error: error instanceof Error ? error.message : String(error), loading: false }))
  }
  useEffect(() => { load() }, [props.projectId, props.path, props.staged])
  const rows = useMemo(() => parseDiff(state.diff), [state.diff])
  const title = props.oldPath ? `${props.oldPath} → ${props.path}` : props.path
  return <div className="diff-view">
    <header className="content-head">
      <button className="ghost content-close" onClick={props.onClose} aria-label="关闭 Diff">×</button>
      <span className="content-name" title={title}>{title}</span>
      <span className="diff-mode">{props.staged ? '暂存区' : '工作区'}</span>
      <button className="ghost" onClick={load} title="刷新 Diff">刷新</button>
    </header>
    {state.loading ? <div className="content-hint">加载 Diff…</div> : state.error ? <div className="content-error">{state.error}</div> : rows.length === 0 ? <div className="content-hint">没有可显示的变更。</div> : <div className="diff-scroll">
      <div className="diff-columns">
        <div className="diff-column"><div className="diff-column-title">旧版本{props.oldPath ? ` · ${props.oldPath}` : ''}</div>{rows.map((row, i) => <div className={`diff-row diff-${row.kind}`} key={`old-${i}`}><span className="diff-no">{row.oldNo ?? ''}</span><code>{row.kind === 'add' ? '' : row.text}</code></div>)}</div>
        <div className="diff-column"><div className="diff-column-title">当前版本 · {props.path}</div>{rows.map((row, i) => <div className={`diff-row diff-${row.kind}`} key={`new-${i}`}><span className="diff-no">{row.newNo ?? ''}</span><code>{row.kind === 'del' ? '' : row.text}</code></div>)}</div>
      </div>
      {state.truncated && <div className="content-hint">Diff 内容过大，已截断。</div>}
    </div>}
  </div>
}
