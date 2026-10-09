import {
  workspaceFileUri,
  type ResourceLink,
} from '@reflexion-os-studio/runtime-client'

/** Recover the old relative-link bug only when the original Markdown proves it. */
export function messageResourceUri(
  link: ResourceLink,
  label: string,
  content: string,
): string {
  if (link.kind !== 'workspaceFile' || link.line !== undefined) return link.uri
  const fragment = /#L([1-9]\d*)(?:-L?[1-9]\d*)?$/.exec(link.path)
  if (!fragment) return link.uri
  const searchable = content
    .replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
    .replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length))
  for (const match of searchable.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    if (match[1] !== label) continue
    const target = match[2].replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
    // Encoded hashes name real files. Only the old raw path + fragment form
    // could have produced this malformed structured resource.
    if (
      target !== link.path &&
      !(target.startsWith('/') && target.endsWith(`/${link.path}`))
    )
      continue
    return workspaceFileUri(
      link.projectId,
      link.path.slice(0, fragment.index),
      Number(fragment[1]),
    )
  }
  return link.uri
}
