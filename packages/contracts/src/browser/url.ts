/** Address-bar normalization. The Host independently enforces the boundary. */
export function normalizeBrowserUrl(input: string): string {
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error('请输入有效的网址')
  const trimmed = input.trim()
  if (
    !trimmed ||
    trimmed.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(trimmed)
  )
    throw new Error('请输入有效的网址')
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  // A hostname:port is an address, not an application protocol.
  const hostPort =
    /^(?:localhost|[a-z\d.-]+|\[[a-f\d:]+\]):\d+(?:[/?#]|$)/i.test(trimmed)
  const url = new URL(
    explicitScheme && !hostPort ? trimmed : `https://${trimmed}`,
  )
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error('只支持不含账号密码的 HTTP / HTTPS 网址')
  return url.href
}
