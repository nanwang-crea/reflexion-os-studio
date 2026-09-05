import { useEffect, useRef, useState } from 'react'
import type {
  GitChangeEntry,
  Project,
  WorkspaceEntry,
} from '@reflexion-os-studio/runtime-client'
import { gitStatus, searchFiles, startIndex } from '../../api/workspace'
import { ChevronIcon, FolderIcon } from '../../ui/icons'
import { AssetsPanel } from './AssetsPanel'
import { FileTree } from './FileTree'
import { GitChanges } from './GitChanges'

interface ProjectFilesProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件树/查看器依赖它，索引器不依赖。 */
  systemReady: boolean
  /** 右侧查看器当前激活文件；用于文件树高亮。 */
  activePath: string | null
  /** 点击文件/Git 变更"打开文件"：交给右侧查看器打开标签。 */
  onOpenFile: (path: string, line?: number) => void
  /** 请求聚焦预览的 Asset（点击消息里的 asset:// 链接）。 */
  focusAssetId?: string | null
  onFocusConsumed?: () => void
}

type View = 'files' | 'git' | 'assets'

/**
 * 侧边栏的项目文件工作区：文件 / Git 变更 / 资产 三视图 + 顶部文件名搜索。
 * 文件树根目录即当前项目目录，惰性展开；搜索用只读 glob（workspace.search_files）
 * 全量匹配文件名，命中即点开右侧查看器。切换项目时重新触发一次索引。
 */
export function ProjectFiles(props: ProjectFilesProps): React.JSX.Element {
  const project = props.project
  const projectId = project?.id ?? null
  const [view, setView] = useState<View>('files')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{
    entries: WorkspaceEntry[]
    truncated: boolean
  } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [treeEpoch, setTreeEpoch] = useState(0)
  const [gitStatusMap, setGitStatusMap] = useState<
    Map<string, GitChangeEntry['status']>
  >(new Map())
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchGeneration = useRef(0)

  // 切换项目：重置视图、搜索并重新触发一次索引（索引按钮不再暴露）。
  useEffect(() => {
    setView('files')
    setQuery('')
    setSearchResults(null)
    setSearchError(null)
    setGitStatusMap(new Map())
    if (projectId !== null) void startIndex(projectId).catch(() => {})
  }, [projectId])

  // 每个项目拉一次 Git 状态，用于文件树行内标记（只读）。
  useEffect(() => {
    if (projectId === null || !props.systemReady) return
    let disposed = false
    void gitStatus(projectId)
      .then((result) => {
        if (disposed) return
        const map = new Map<string, GitChangeEntry['status']>()
        for (const entry of result.entries) {
          map.set(entry.path, entry.status)
        }
        setGitStatusMap(map)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [projectId, props.systemReady])

  // 文件名搜索：防抖 250ms；清空时回到文件树。
  useEffect(() => {
    if (projectId === null) return
    const keyword = query.trim()
    if (keyword === '') {
      searchGeneration.current += 1
      setSearching(false)
      setSearchResults(null)
      setSearchError(null)
      return
    }
    if (!props.systemReady) {
      setSearchError('工具 Runtime 不可用，无法搜索文件')
      return
    }
    setSearching(true)
    setSearchError(null)
    const generation = ++searchGeneration.current
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      void searchFiles(projectId, keyword)
        .then((result) => {
          if (generation !== searchGeneration.current) return
          setSearchResults(result)
          setSearching(false)
        })
        .catch((error: unknown) => {
          if (generation !== searchGeneration.current) return
          setSearchResults(null)
          setSearchError(error instanceof Error ? error.message : String(error))
          setSearching(false)
        })
    }, 250)
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    }
  }, [query, projectId, props.systemReady])

  if (project === null) {
    return (
      <div className="project-files">
        <div className="project-files-empty">
          <FolderIcon />
          <p>点击项目旁的文件夹图标，可在这里浏览工作区文件。</p>
        </div>
      </div>
    )
  }

  const basename = project.name

  return (
    <div className="project-files">
      <div className="project-files-head" title={project.folderPath}>
        <span className="project-files-title">{basename}</span>
      </div>

      <div className="project-files-tabs">
        <button
          type="button"
          className={`project-files-tab${view === 'files' ? ' active' : ''}`}
          onClick={() => setView('files')}
        >
          文件
        </button>
        <button
          type="button"
          className={`project-files-tab${view === 'git' ? ' active' : ''}`}
          onClick={() => setView('git')}
        >
          Git 变更
        </button>
        <button
          type="button"
          className={`project-files-tab${view === 'assets' ? ' active' : ''}`}
          onClick={() => setView('assets')}
        >
          资产
        </button>
      </div>

      <div className="project-files-body">
        {view === 'files' ? (
          <>
            <div className="file-search">
              <input
                type="text"
                placeholder="搜索文件名…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索文件名"
              />
              {searching && <span className="file-search-hint">搜索中…</span>}
            </div>
            {searchError !== null && (
              <div className="tree-hint tree-hint-error">{searchError}</div>
            )}
            {searchResults !== null ? (
              <SearchResults
                entries={searchResults.entries}
                truncated={searchResults.truncated}
                activePath={props.activePath}
                onOpenFile={props.onOpenFile}
              />
            ) : (
              <FileTree
                key={`${project.id}-${treeEpoch}`}
                projectId={project.id}
                systemReady={props.systemReady}
                activePath={props.activePath}
                gitStatus={gitStatusMap}
                onOpenFile={props.onOpenFile}
                onRefresh={() => setTreeEpoch((epoch) => epoch + 1)}
              />
            )}
          </>
        ) : view === 'git' ? (
          <GitChanges
            projectId={project.id}
            systemReady={props.systemReady}
            onOpenFile={props.onOpenFile}
          />
        ) : (
          <AssetsPanel
            projectId={project.id}
            focusAssetId={props.focusAssetId}
            onFocusConsumed={props.onFocusConsumed}
          />
        )}
      </div>
    </div>
  )
}

interface SearchResultsProps {
  entries: WorkspaceEntry[]
  truncated: boolean
  activePath: string | null
  onOpenFile: (path: string, line?: number) => void
}

function SearchResults(props: SearchResultsProps): React.JSX.Element {
  if (props.entries.length === 0) {
    return <div className="tree-hint">没有匹配的文件。</div>
  }
  const sorted = props.entries
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
  return (
    <ul className="file-search-results">
      {sorted.map((entry) => {
        const active = entry.path === props.activePath
        return (
          <li key={entry.path}>
            <button
              type="button"
              className={`tree-row tree-file${active ? ' active' : ''}`}
              title={entry.path}
              onClick={() => props.onOpenFile(entry.path)}
            >
              <ChevronIcon />
              <span className="tree-name">{entry.path}</span>
            </button>
          </li>
        )
      })}
      {props.truncated && (
        <li className="tree-hint">结果过多，仅显示前 {sorted.length} 条。</li>
      )}
    </ul>
  )
}
