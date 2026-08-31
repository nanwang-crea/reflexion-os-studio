import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceEntry } from '@reflexion-os-studio/runtime-client'
import { listDir } from '../../api/workspace'
import { ChevronIcon, FolderIcon, RefreshIcon } from '../../ui/icons'

interface FileTreeProps {
  projectId: string
  /** Rust 不可用时降级为错误提示（索引仍可用）。 */
  systemReady: boolean
  activePath: string | null
  onOpenFile: (path: string) => void
  /** 外部刷新（换项目/手动刷新）时重新加载根目录。 */
  onRefresh: () => void
}

type DirState = 'idle' | 'loading' | 'loaded' | 'error'

/**
 * 按需加载的目录树（非递归、惰性展开）：目录条目在展开时才调 file.list，
 * 避免大工作区一次性把整个树拉下来。目录在前、文件在后，各自按名排序。
 */
export function FileTree(props: FileTreeProps): React.JSX.Element {
  const [entries, setEntries] = useState<Map<string, WorkspaceEntry[]>>(
    new Map(),
  )
  const [dirState, setDirState] = useState<Map<string, DirState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [rootError, setRootError] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())

  useEffect(() => {
    let disposed = false
    void loadDir('.')
    async function loadDir(path: string): Promise<void> {
      if (disposed || !props.systemReady) return
      if (inFlight.current.has(path)) return
      inFlight.current.add(path)
      setRootError(null)
      setDirState((state) => new Map(state).set(path, 'loading'))
      try {
        const result = await listDir(props.projectId, path)
        if (disposed) return
        setEntries((map) => new Map(map).set(path, result.entries))
        setDirState((state) => new Map(state).set(path, 'loaded'))
      } catch (error) {
        if (disposed) return
        setDirState((state) => new Map(state).set(path, 'error'))
        setRootError(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight.current.delete(path)
      }
    }
    return () => {
      disposed = true
    }
  }, [props.projectId, props.systemReady])

  const loadOnce = useCallback(
    async (path: string): Promise<void> => {
      if (!props.systemReady) return
      setDirState((state) => new Map(state).set(path, 'loading'))
      try {
        const result = await listDir(props.projectId, path)
        setEntries((map) => new Map(map).set(path, result.entries))
        setDirState((state) => new Map(state).set(path, 'loaded'))
      } catch {
        setDirState((state) => new Map(state).set(path, 'error'))
      }
    },
    [props.projectId, props.systemReady],
  )

  const toggle = useCallback(
    (path: string): void => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      if (!entries.has(path) && !inFlight.current.has(path)) {
        void loadOnce(path)
      }
    },
    [entries, loadOnce],
  )

  const renderDir = (path: string, depth: number): React.JSX.Element => {
    const dirEntries = entries.get(path) ?? []
    const state = dirState.get(path) ?? 'idle'
    const isExpanded = expanded.has(path)
    return (
      <li key={path}>
        <button
          type="button"
          className={`tree-row tree-dir${isExpanded ? ' open' : ''}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => toggle(path)}
        >
          <span className={`tree-chevron${isExpanded ? ' open' : ''}`}>
            <ChevronIcon />
          </span>
          <FolderIcon />
          <span className="tree-name">
            {path === '.' ? '（工作区根目录）' : basename(path)}
          </span>
        </button>
        {isExpanded && (
          <ul className="tree-children">
            {state === 'loading' && !hasAnyEntries(dirEntries) && (
              <li className="tree-hint">加载中…</li>
            )}
            {state === 'error' && (
              <li className="tree-hint tree-hint-error">
                加载失败，点上方刷新重试
              </li>
            )}
            {dirEntries
              .slice()
              .sort(compareEntries)
              .map((entry) =>
                entry.kind === 'dir' ? (
                  renderDir(entry.path, depth + 1)
                ) : (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={`tree-row tree-file${
                        props.activePath === entry.path ? ' active' : ''
                      }`}
                      style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
                      onClick={() => props.onOpenFile(entry.path)}
                      title={entry.path}
                    >
                      <span className="tree-file-dot" aria-hidden="true" />
                      <span className="tree-name">{basename(entry.path)}</span>
                    </button>
                  </li>
                ),
              )}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="file-tree">
      <div className="file-tree-bar">
        <span>文件</span>
        <button
          className="ghost"
          title="刷新文件树"
          onClick={() => {
            setEntries(new Map())
            props.onRefresh()
          }}
        >
          <RefreshIcon />
        </button>
      </div>
      {rootError && (
        <div className="tree-hint tree-hint-error">{rootError}</div>
      )}
      <ul className="tree-root">{renderDir('.', 0)}</ul>
    </div>
  )
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function hasAnyEntries(entries: WorkspaceEntry[]): boolean {
  return entries.length > 0
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.path.localeCompare(b.path)
}
