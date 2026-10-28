import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import type {
  WorkspaceEntry,
  WorkspaceReadResult,
} from '@reflexion-os-studio/runtime-client'
import { Select } from '../../components/forms/Select'
import { listDir, readFile } from '../../api/workspace'

type RemoteProject = RemoteCatalog['projects'][number]

export function RemoteFiles({
  projects,
  initialProjectId,
  initialPath,
  onBack,
}: {
  projects: RemoteProject[]
  initialProjectId?: string | null
  initialPath?: string
  onBack: () => void
}): React.JSX.Element {
  const [projectId, setProjectId] = useState(
    () =>
      (initialProjectId &&
      projects.some((project) => project.id === initialProjectId)
        ? initialProjectId
        : projects[0]?.id) ?? '',
  )
  const [directory, setDirectory] = useState('.')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [file, setFile] = useState<WorkspaceReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)

  const loadDirectory = useCallback(
    async (nextDirectory: string): Promise<void> => {
      if (!projectId) return
      const currentRequest = ++requestId.current
      setBusy(true)
      setError(null)
      try {
        const result = await listDir(projectId, nextDirectory, 0, 500)
        if (currentRequest !== requestId.current) return
        setDirectory(nextDirectory)
        setEntries(result.entries)
        setNextOffset(result.nextOffset ?? null)
        setFilePath(null)
        setFile(null)
      } catch (cause) {
        if (currentRequest !== requestId.current) return
        setError(cause instanceof Error ? cause.message : '读取目录失败')
      } finally {
        if (currentRequest === requestId.current) setBusy(false)
      }
    },
    [projectId],
  )

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      if (!projectId) return
      const currentRequest = ++requestId.current
      setBusy(true)
      setError(null)
      setFilePath(path)
      setDirectory(path.split(/[\\/]/).slice(0, -1).join('/') || '.')
      try {
        const result = await readFile(projectId, path, {
          limit: 1000,
          preserveLineEndings: true,
        })
        if (currentRequest !== requestId.current) return
        setFile(result)
      } catch (cause) {
        if (currentRequest !== requestId.current) return
        setError(cause instanceof Error ? cause.message : '读取文件失败')
      } finally {
        if (currentRequest === requestId.current) setBusy(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) return
    let disposed = false
    const currentRequest = ++requestId.current
    setDirectory('.')
    setFilePath(null)
    setFile(null)
    if (initialPath && initialProjectId === projectId) {
      const parentDirectory =
        initialPath.split(/[\\/]/).slice(0, -1).join('/') || '.'
      setBusy(true)
      setError(null)
      void Promise.all([
        listDir(projectId, parentDirectory, 0, 500),
        readFile(projectId, initialPath, {
          limit: 1000,
          preserveLineEndings: true,
        }),
      ])
        .then(([directoryResult, fileResult]) => {
          if (disposed || currentRequest !== requestId.current) return
          setDirectory(parentDirectory)
          setEntries(directoryResult.entries)
          setNextOffset(directoryResult.nextOffset ?? null)
          setFilePath(initialPath)
          setFile(fileResult)
        })
        .catch((cause: unknown) => {
          if (!disposed && currentRequest === requestId.current)
            setError(cause instanceof Error ? cause.message : '读取文件失败')
        })
        .finally(() => {
          if (!disposed && currentRequest === requestId.current) setBusy(false)
        })
    } else {
      void loadDirectory('.')
    }
    return () => {
      disposed = true
      requestId.current += 1
    }
  }, [initialPath, initialProjectId, loadDirectory, projectId])

  const parent =
    directory === '.'
      ? null
      : directory.split(/[\\/]/).slice(0, -1).join('/') || '.'
  const projectName = projects.find((project) => project.id === projectId)?.name

  return (
    <main className="remote-files">
      <header className="remote-header">
        <button className="ghost" onClick={onBack}>
          所有会话
        </button>
        <strong>项目文件</strong>
        {projects.length > 0 && (
          <Select
            value={projectId}
            onValueChange={setProjectId}
            aria-label="选择项目"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        )}
      </header>
      {!projectId && <p>没有可浏览的项目。</p>}
      {projectId && (
        <section
          className="remote-files-body"
          aria-label={`${projectName ?? '项目'}文件`}
        >
          <div className="remote-files-toolbar">
            {filePath ? (
              <>
                <button
                  className="ghost"
                  onClick={() => void loadDirectory(directory)}
                >
                  返回目录
                </button>
                <span>{filePath}</span>
              </>
            ) : (
              <>
                {parent && (
                  <button
                    className="ghost"
                    onClick={() => void loadDirectory(parent)}
                  >
                    上一级
                  </button>
                )}
                <span>{directory === '.' ? projectName : directory}</span>
              </>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">正在读取…</p>}
          {!filePath && (
            <>
              <ul className="remote-file-list">
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        entry.kind === 'dir'
                          ? void loadDirectory(entry.path)
                          : void openFile(entry.path)
                      }
                    >
                      <span aria-hidden="true">
                        {entry.kind === 'dir' ? '📁' : '📄'}
                      </span>
                      <span>{entry.path.split(/[\\/]/).at(-1)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {nextOffset !== null && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!projectId) return
                    const currentRequest = ++requestId.current
                    setBusy(true)
                    void listDir(projectId, directory, nextOffset, 500)
                      .then((result) => {
                        if (currentRequest !== requestId.current) return
                        setEntries((current) => [...current, ...result.entries])
                        setNextOffset(result.nextOffset ?? null)
                      })
                      .catch(() => {
                        if (currentRequest === requestId.current)
                          setError('继续读取目录失败')
                      })
                      .finally(() => {
                        if (currentRequest === requestId.current) setBusy(false)
                      })
                  }}
                >
                  加载更多
                </button>
              )}
            </>
          )}
          {filePath && file && (
            <>
              <pre className="remote-file-content">{file.content}</pre>
              {!file.readComplete && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    const currentRequest = ++requestId.current
                    setBusy(true)
                    void readFile(projectId, filePath, {
                      offset:
                        file.offset +
                        (file.content.match(/\n/g)?.length ?? 0) +
                        (file.content.endsWith('\n') || file.content === ''
                          ? 0
                          : 1),
                      limit: 1000,
                      preserveLineEndings: true,
                    })
                      .then((next) => {
                        if (currentRequest !== requestId.current) return
                        setFile({
                          ...next,
                          content: file.content + next.content,
                        })
                      })
                      .catch(() => {
                        if (currentRequest === requestId.current)
                          setError('继续读取文件失败')
                      })
                      .finally(() => {
                        if (currentRequest === requestId.current) setBusy(false)
                      })
                  }}
                >
                  继续读取
                </button>
              )}
            </>
          )}
          {!busy && !error && !filePath && entries.length === 0 && (
            <p>此目录为空。</p>
          )}
        </section>
      )}
    </main>
  )
}
