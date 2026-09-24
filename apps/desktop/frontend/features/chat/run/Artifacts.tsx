import { useMemo } from 'react'
import type {
  ResourceLink,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import {
  displayNameOf,
  extractResourceLinks,
} from '../../../components/markdown/md-core-types'
import type { ProcessItem } from './RunProcess'

interface ArtifactsProps {
  items: ProcessItem[]
  finalItem: ProcessItem | null
  projectId: string
  onResourceClick?: (link: ResourceLink) => void
}

/** Run-level Artifact projection from canonical tool outputs and message links. */
export function Artifacts(props: ArtifactsProps): React.JSX.Element | null {
  const links = useMemo(
    () => aggregateArtifactLinks(props.items, props.finalItem, props.projectId),
    [props.items, props.finalItem, props.projectId],
  )
  if (links.length === 0) return null
  return (
    <div className="artifact-links" aria-label="运行产物">
      {links.map((link) => (
        <button
          type="button"
          className="artifact-chip"
          key={link.uri}
          onClick={() => props.onResourceClick?.(link)}
        >
          <span className="artifact-kind">{kindLabel(link)}</span>
          <span className="artifact-target">{displayNameOf(link)}</span>
        </button>
      ))}
    </div>
  )
}

export function aggregateArtifactLinks(
  items: ProcessItem[],
  finalItem: ProcessItem | null,
  projectId: string,
): ResourceLink[] {
  const allItems = [...items, ...(finalItem === null ? [] : [finalItem])]
  const byUri = new Map<string, ResourceLink>()
  for (const item of allItems) {
    for (const link of linksFromToolCalls(item.toolCalls, projectId)) {
      if (link.kind !== 'externalUrl') byUri.set(link.uri, link)
    }
    for (const part of item.message.parts) {
      if (part.type === 'resource_link' && part.link.kind !== 'externalUrl') {
        byUri.set(part.link.uri, part.link)
      }
    }
    for (const link of extractResourceLinks(item.message.content)) {
      if (link.kind !== 'externalUrl') byUri.set(link.uri, link)
    }
  }
  return [...byUri.values()]
}

function linksFromToolCalls(
  calls: ToolCall[],
  projectId: string,
): ResourceLink[] {
  const links: ResourceLink[] = []
  for (const call of calls) {
    if (call.status !== 'completed') continue
    links.push(...(call.output?.resourceLinks ?? []))
    if (projectId === '') continue
    for (const file of call.output?.changedFiles ?? []) {
      links.push({
        kind: 'workspaceFile',
        uri: workspaceFileUri(projectId, file.path),
        projectId,
        path: file.path,
      })
    }
  }
  return links
}

function kindLabel(link: ResourceLink): string {
  if (link.kind === 'workspaceFile') return '文件'
  if (link.kind === 'asset') return '资产'
  return '链接'
}
