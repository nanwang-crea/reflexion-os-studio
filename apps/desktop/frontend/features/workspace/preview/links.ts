import {
  workspaceFileUri,
  parseResourceUri,
  type ResourceLink,
} from '@reflexion-os-studio/runtime-client'

/**
 * 预览内相对路径链接 → 工作区路径换算（纯逻辑）：
 * - `./`、`../`、`sub/x.md` 相对当前 md 文件所在目录解析；
 * - `/abs/path` 按工作区根相对路径处理；
 * - http(s)/mailto 等外部协议与 Windows 盘符路径不在此列（返回 null）。
 * 越出工作区根（过多 `..`）或解析结果为空时同样返回 null。
 */
export function normalizeRelativePath(
  base: string,
  target: string,
): string | null {
  let cleaned: string
  try {
    cleaned = decodeURIComponent(target.split(/[?#]/)[0].trim()).replaceAll(
      '\\',
      '/',
    )
  } catch {
    return null
  }
  if (cleaned === '') return null
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned)) return null
  if (/^[a-zA-Z]:\//.test(cleaned)) return null
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const stack = cleaned.startsWith('/') || dir === '' ? [] : dir.split('/')
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.length === 0 ? null : stack.join('/')
}

/** Markdown 文件中的相对引用保留行号；普通标题锚点仍按文件打开。 */
export function relativeWorkspaceResource(
  projectId: string,
  base: string,
  target: string,
): ResourceLink | null {
  const path = normalizeRelativePath(base, target)
  if (path === null) return null
  const uri = workspaceFileUri(projectId, path)
  const hash = target.indexOf('#')
  if (hash >= 0) {
    try {
      return parseResourceUri(uri + target.slice(hash))
    } catch {
      // 非行号的标题锚点沿用既有行为：打开文件，暂不定位标题。
    }
  }
  return parseResourceUri(uri)
}
