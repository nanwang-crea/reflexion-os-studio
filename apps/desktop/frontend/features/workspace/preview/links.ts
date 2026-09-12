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
  const cleaned = target.replace(/\\/g, '/').split(/[?#]/)[0].trim()
  if (cleaned === '') return null
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleaned)) return null
  if (/^[a-zA-Z]:\//.test(cleaned)) return null
  if (cleaned.startsWith('/')) return cleaned.slice(1)
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const stack = dir === '' ? [] : dir.split('/')
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
