import { useMemo } from 'react'
import type {
  ChangedFile,
  ResourceLink,
} from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'
import type { ProcessItem } from './RunProcess'

const MUTATION_TOOLS = new Set([
  'file.write',
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
  for (const call of calls) {
    if (
      seenCalls.has(call.id) ||
      call.status !== 'completed' ||
      !MUTATION_TOOLS.has(call.toolName)
    )
      continue
    seenCalls.add(call.id)
    const result = call.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue
    const changedFiles = (result as { changedFiles?: unknown }).changedFiles
    if (!Array.isArray(changedFiles)) continue
    for (const file of changedFiles) {
      if (
        !file ||
        typeof file !== 'object' ||
        typeof (file as ChangedFile).path !== 'string'
      )
        continue
      const value = file as ChangedFile
      files.set(value.path, value)
    }
  }
  return [...files.values()]
}

interface ChangedFilesProps {
  items: ProcessItem[]
  finalItem: ProcessItem | null
  projectId: string
  onResourceClick?: (link: ResourceLink) => void
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
  const files = useMemo(
    () => aggregateChangedFiles(props.items, props.finalItem),
    [props.items, props.finalItem],
  )
  if (files.length === 0) return null
  return (
    <details className="changed-files">
      <summary>
        <span>已变更文件</span>
        <span className="changed-files-count">{files.length}</span>
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
              onClick={() => props.onResourceClick?.(link)}
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
