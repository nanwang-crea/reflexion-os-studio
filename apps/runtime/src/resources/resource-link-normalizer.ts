import { isAbsolute, relative, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import {
  resourceLinkFromUri,
  workspaceFileUri,
  type ContentPart,
  type ResourceLink,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'

interface SessionContext {
  projectId: string | null
}

function within(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function normalizeUri(
  raw: string,
  session: SessionContext,
  store: Store,
): ResourceLink {
  const hash = raw.indexOf('#')
  const target = hash < 0 ? raw : raw.slice(0, hash)
  const fragment = hash < 0 ? '' : raw.slice(hash + 1)
  const line = fragment === '' ? undefined : /^L([1-9]\d*)$/.exec(fragment)?.[1]
  if (fragment !== '' && line === undefined)
    throw new Error('Invalid resource fragment')
  if (target.startsWith('workspace:///')) {
    if (session.projectId === null)
      throw new Error('Resource requires a project session')
    const path = target.slice('workspace:///'.length)
    if (!path || path.split('/').includes('..'))
      throw new Error('Invalid workspace path')
    return resourceLinkFromUri(
      workspaceFileUri(
        session.projectId,
        path,
        line ? Number(line) : undefined,
      ),
    )
  }
  if (target.startsWith('workspace://')) return resourceLinkFromUri(raw)
  if (target.startsWith('asset://')) return resourceLinkFromUri(raw)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    parsed = null as never
  }
  if (parsed?.protocol === 'https:') return resourceLinkFromUri(raw)
  if (/^[a-z][a-z\d+.-]*:/i.test(raw))
    throw new Error('Unsupported resource URI')

  if (session.projectId === null)
    throw new Error('Relative resource requires a project session')
  const project = store.projects.get(session.projectId)
  if (!project || project.folderPath === '')
    throw new Error('Project workspace unavailable')
  const candidate = isAbsolute(raw)
    ? resolve(raw)
    : resolve(project.folderPath, raw)
  if (!within(project.folderPath, candidate))
    throw new Error('Resource is outside workspace')
  const path = relative(resolve(project.folderPath), candidate)
  if (!path || path.split(/[\\/]/).includes('..'))
    throw new Error('Invalid workspace path')
  return resourceLinkFromUri(
    workspaceFileUri(session.projectId, path.split(sep).join('/')),
  )
}

export function normalizeContent(
  content: string,
  session: SessionContext,
  store: Store,
): {
  content: string
  parts: ContentPart[]
} {
  const parts: ContentPart[] = []
  // Code examples are display text, not explicit resource links.
  const searchable = content
    .replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
    .replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length))
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  for (const match of searchable.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last)
      parts.push({ type: 'text', text: content.slice(last, index) })
    try {
      parts.push({
        type: 'resource_link',
        label: match[1],
        link: normalizeUri(match[2], session, store),
      })
    } catch {
      parts.push({ type: 'text', text: match[0] })
    }
    last = index + match[0].length
  }
  if (last < content.length)
    parts.push({ type: 'text', text: content.slice(last) })
  return {
    content,
    parts: parts.length
      ? parts
      : content
        ? [{ type: 'text', text: content }]
        : [],
  }
}
