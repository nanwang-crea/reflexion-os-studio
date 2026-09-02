import { z } from 'zod'

export const ResourceLinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspaceFile'),
    uri: z.string().min(1),
    projectId: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('asset'),
    uri: z.string().min(1),
    assetId: z.string().min(1),
  }),
  z.object({ kind: z.literal('externalUrl'), uri: z.string().min(1) }),
])
export type ResourceLink = z.infer<typeof ResourceLinkSchema>

/** Construct canonical, URI-encoded resource references. */
export function workspaceFileUri(
  projectId: string,
  path: string,
  line?: number,
): string {
  const base = `workspace://${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`
  return line === undefined ? base : `${base}#L${line}`
}
export function assetUri(assetId: string): string {
  return `asset://${encodeURIComponent(assetId)}`
}

/** Parse a supported resource URI without accepting filesystem paths or other schemes. */
export function parseResourceUri(uri: string): ResourceLink {
  const hash = uri.indexOf('#')
  const raw = hash < 0 ? uri : uri.slice(0, hash)
  const fragment = hash < 0 ? '' : uri.slice(hash + 1)
  if (raw.startsWith('workspace://')) {
    const rest = raw.slice('workspace://'.length)
    const slash = rest.indexOf('/')
    if (slash < 1) throw new Error('Invalid workspace resource URI')
    const projectId = decodeURIComponent(rest.slice(0, slash))
    const path = rest
      .slice(slash + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    const line =
      fragment === '' ? undefined : /^L([1-9]\d*)$/.exec(fragment)?.[1]
    if (path === '' || (fragment !== '' && line === undefined))
      throw new Error('Invalid workspace resource URI')
    return {
      kind: 'workspaceFile',
      uri,
      projectId,
      path,
      ...(line ? { line: Number(line) } : {}),
    }
  }
  if (raw.startsWith('asset://')) {
    const assetId = decodeURIComponent(raw.slice('asset://'.length))
    if (!assetId || fragment) throw new Error('Invalid asset resource URI')
    return { kind: 'asset', uri, assetId }
  }
  if (/^https:\/\//i.test(uri)) return { kind: 'externalUrl', uri }
  throw new Error('Unsupported resource URI')
}

export function resourceLinkFromUri(uri: string): ResourceLink {
  return parseResourceUri(uri)
}
