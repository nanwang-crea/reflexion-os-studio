import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceEntry } from '@reflexion-os-studio/runtime-client'
import { listDir } from '../../api/workspace'
import { ChevronIcon, FolderIcon, RefreshIcon } from '../../ui/icons'

interface FileTreeProps {
  projectId: string
  /** Rust 不可用时降级为错误提示（索引仍可用）。 */
  systemReady: boolean
  activePath: string | null
  /** 各文件的 Git 状态（workspace 相对路径 → 状态）；缺省不显示标记。 */
  gitStatus?: ReadonlyMap<string, string>
  onOpenFile: (path: string, line?: number) => void
  /** 外部刷新（换项目/手动刷新）时重新加载根目录。 */
  onRefresh: () => void
}

type DirState = 'idle' | 'loading' | 'loaded' | 'error'

interface DirPage {
  nextOffset: number | null
  truncated: boolean
}

const EMPTY_STATUS: ReadonlyMap<string, string> = new Map()

/**
 * 按需加载的目录树（非递归、惰性展开）：目录条目在展开时才调 file.list，
 * 避免大工作区一次性把整个树拉下来。目录在前、文件在后，各自按名排序。
 */
export function FileTree(props: FileTreeProps): React.JSX.Element {
  const [entries, setEntries] = useState<Map<string, WorkspaceEntry[]>>(
    new Map(),
  )
  const [dirState, setDirState] = useState<Map<string, DirState>>(new Map())
  const [pages, setPages] = useState<Map<string, DirPage>>(new Map())
  const [loadingMore, setLoadingMore] = useState<Map<string, boolean>>(
    new Map(),
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [rootError, setRootError] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())
  // 项目代次：切项目/刷新时自增，旧的异步响应据此丢弃，避免污染新项目。
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    inFlight.current.clear()
    void loadDir('.')
    async function loadDir(path: string): Promise<void> {
      if (generation !== generationRef.current || !props.systemReady) return
      if (inFlight.current.has(path)) return
      inFlight.current.add(path)
      setRootError(null)
      setDirState((state) => new Map(state).set(path, 'loading'))
      try {
        const result = await listDir(props.projectId, path)
        if (generation !== generationRef.current) return
        setEntries((map) => new Map(map).set(path, result.entries))
        setPages((map) =>
          new Map(map).set(path, {
            nextOffset: result.nextOffset ?? null,
            truncated: result.truncated,
          }),
        )
        setLoadingMore((map) => new Map(map).set(path, false))
        setDirState((state) => new Map(state).set(path, 'loaded'))
      } catch (error) {
        if (generation !== generationRef.current) return
        setDirState((state) => new Map(state).set(path, 'error'))
        setRootError(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight.current.delete(path)
      }
    }
    return () => {
      // 不在此处自增：unmount 后停止即可，但切项目时是一般 effect 重新执行，
      // 上面的代码路径会先自增 generation，因此旧的 loadDir/loadOnce 会自然失效。
    }
  }, [props.projectId, props.systemReady])

  const loadOnce = useCallback(
    async (path: string): Promise<void> => {
      const generation = generationRef.current
      if (!props.systemReady || inFlight.current.has(path)) return
      inFlight.current.add(path)
      setDirState((state) => new Map(state).set(path, 'loading'))
      try {
        const result = await listDir(props.projectId, path)
        if (generation !== generationRef.current) return
        setEntries((map) => new Map(map).set(path, result.entries))
        setPages((map) =>
          new Map(map).set(path, {
            nextOffset: result.nextOffset ?? null,
            truncated: result.truncated,
          }),
        )
        setLoadingMore((map) => new Map(map).set(path, false))
        setDirState((state) => new Map(state).set(path, 'loaded'))
      } catch {
        if (generation !== generationRef.current) return
        setDirState((state) => new Map(state).set(path, 'error'))
      } finally {
        inFlight.current.delete(path)
      }
    },
    [props.projectId, props.systemReady],
  )

  const loadMore = useCallback(
    async (path: string, offset: number): Promise<void> => {
      const generation = generationRef.current
      if (!props.systemReady || inFlight.current.has(path)) return
      inFlight.current.add(path)
      setLoadingMore((map) => new Map(map).set(path, true))
      try {
        const result = await listDir(props.projectId, path, offset)
        if (generation !== generationRef.current) return
        setEntries((map) => {
          const current = map.get(path) ?? []
          return new Map(map).set(path, mergeUnique(current, result.entries))
        })
        setPages((map) =>
          new Map(map).set(path, {
            nextOffset: result.nextOffset ?? null,
            truncated: result.truncated,
          }),
        )
        setDirState((state) => new Map(state).set(path, 'loaded'))
      } catch {
        if (generation !== generationRef.current) return
        setDirState((state) => new Map(state).set(path, 'error'))
      } finally {
        inFlight.current.delete(path)
        setLoadingMore((map) => new Map(map).set(path, false))
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
    const page = pages.get(path)
    const isLoadingMore = loadingMore.get(path) === true
    const isExpanded = expanded.has(path)
    const gitStatus = props.gitStatus ?? EMPTY_STATUS
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
                      {gitStatus.has(entry.path) && (
                        <span
                          className={`git-dot git-dot-${gitStatus.get(entry.path)}`}
                          title={`Git 状态：${gitStatus.get(entry.path)}`}
                          aria-hidden="true"
                        />
                      )}
                      <span className="tree-name">{basename(entry.path)}</span>
                    </button>
                  </li>
                ),
              )}
            {page?.nextOffset != null && (
              <li className="tree-more-row">
                <button
                  type="button"
                  className="ghost"
                  disabled={isLoadingMore}
                  onClick={() => {
                    if (page.nextOffset != null) {
                      void loadMore(path, page.nextOffset)
                    }
                  }}
                >
                  {isLoadingMore ? '加载中…' : '加载更多'}
                </button>
              </li>
            )}
            {page?.truncated && page.nextOffset == null && (
              <li className="tree-hint tree-hint-error">
                目录结果不完整，建议缩小目录范围
              </li>
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

function mergeUnique(
  current: WorkspaceEntry[],
  incoming: WorkspaceEntry[],
): WorkspaceEntry[] {
  if (incoming.length === 0) return current
  const seen = new Set(current.map((entry) => entry.path))
  const merged = current.slice()
  for (const entry of incoming) {
    if (!seen.has(entry.path)) {
      seen.add(entry.path)
      merged.push(entry)
    }
  }
  return merged
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.path.localeCompare(b.path)
}
