import type {
  ChangedFile,
  ResourceLink,
} from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../../ui/icons'
import type { ProcessItem } from './RunProcess'

const MUTATION_TOOLS = new Set([
  'file.write',
  'file.write_stream',
  'file.edit',
  'file.delete',
  'file.move',
])

/** Collect successful filesystem changes from every tool-call occurrence. */
export function aggregateChangedFiles(
  items: ProcessItem[],
  finalItem: ProcessItem | null,
): ChangedFile[] {
  const calls = [
    ...items.flatMap((item) => item.toolCalls),
    ...(finalItem?.toolCalls ?? []),
  ]
  const seenCalls = new Set<string>()
  const files = new Map<string, ChangedFile>()
  const record = (file: ChangedFile) => {
    const key = normalizeFilePath(file.path)
    if (file.action === 'moved' && file.oldPath)
      files.delete(normalizeFilePath(file.oldPath))
    // Keep the last occurrence in execution order (including move/recreate).
    files.delete(key)
    files.set(key, file)
  }
  for (const call of calls) {
    if (seenCalls.has(call.id) || call.status !== 'completed') continue
    seenCalls.add(call.id)
    const canonicalFiles = call.output?.changedFiles
    if (canonicalFiles && canonicalFiles.length > 0) {
      for (const file of canonicalFiles) record(file)
      continue
    }
    if (!MUTATION_TOOLS.has(call.toolName)) continue
    // Older runtime snapshots expose only the legacy result projection.
    const result = call.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue
    const changedFiles = (result as { changedFiles?: unknown }).changedFiles
    const fallbackPath = (call.args as { path?: unknown }).path
    const fallbackFiles =
      Array.isArray(changedFiles) || typeof fallbackPath !== 'string'
        ? changedFiles
        : [
            {
              path: fallbackPath,
              action:
                call.toolName === 'file.write' ||
                call.toolName === 'file.write_stream'
                  ? 'modified'
                  : call.toolName === 'file.edit'
                    ? 'modified'
                    : call.toolName === 'file.delete'
                      ? 'deleted'
                      : undefined,
            },
          ]
    if (!Array.isArray(fallbackFiles)) continue
    for (const file of fallbackFiles) {
      if (
        !file ||
        typeof file !== 'object' ||
        typeof (file as ChangedFile).path !== 'string'
      )
        continue
      const value = file as ChangedFile
      record(value)
    }
  }
  return [...files.values()]
}

function normalizeFilePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
}

interface ChangedFilesProps {
  files: ChangedFile[]
  projectId: string
  onResourceClick?: (link: ResourceLink) => void
  /** 有快照时打开本次编辑 Diff，否则降级 onResourceClick。 */
  onOpenDiff?: (
    path: string,
    options: {
      source: 'chat'
      before?: string
      after?: string
      oldPath?: string
    },
  ) => void
}

const ACTION_LABELS: Record<string, string> = {
  created: '新建',
  modified: '修改',
  deleted: '删除',
  moved: '移动',
}

export function ChangedFiles(
  props: ChangedFilesProps,
): React.JSX.Element | null {
  const { files } = props
  if (files.length === 0) return null
  return (
    <details className="changed-files">
      <summary>
        <span>变更了 {files.length} 个文件</span>
        <span className="changed-files-hint">查看变更</span>
        <ChevronIcon />
      </summary>
      <div className="changed-files-list">
        {files.map((file) => {
          const link: ResourceLink = {
            kind: 'workspaceFile',
            uri: workspaceFileUri(props.projectId, file.path),
            projectId: props.projectId,
            path: file.path,
          }
          return (
            <button
              type="button"
              className="changed-file"
              key={file.path}
              onClick={() => {
                // 有编辑前后快照时展示「本次编辑」双栏 Diff；否则降级打开文件。
                if (
                  props.onOpenDiff !== undefined &&
                  (file.before !== undefined || file.after !== undefined)
                ) {
                  props.onOpenDiff(file.path, {
                    source: 'chat',
                    before: file.before,
                    after: file.after,
                    oldPath: file.oldPath,
                  })
                  return
                }
                props.onResourceClick?.(link)
              }}
            >
              <span className={`changed-file-action ${file.action}`}>
                {ACTION_LABELS[file.action] ?? '变更'}
              </span>
              <span>
                {file.action === 'moved' && file.oldPath
                  ? `${file.oldPath} → ${file.path}`
                  : file.path}
              </span>
            </button>
          )
        })}
      </div>
    </details>
  )
}
