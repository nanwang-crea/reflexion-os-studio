import { requestWeb } from './request.js'

const MAX_REDIRECTS = 5

export interface SafeResponse {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  bodyTruncated: boolean
  arrayBuffer(): Promise<ArrayBuffer>
}

export async function safeFetch(
  initial: URL,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<{ response: SafeResponse; finalUrl: string; redirects: number }> {
  let current = initial
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    init.signal.throwIfAborted()
    validateWebUrl(current)
    const response = await requestWeb(current, init)
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current.href, redirects }
    }
    if (redirects === MAX_REDIRECTS) throw new Error('重定向次数超过上限')
    const location = response.headers.get('location')
    if (!location) throw new Error('重定向响应缺少 Location')
    current = new URL(location, current)
  }
  throw new Error('重定向次数超过上限')
}

function validateWebUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('仅支持 http/https URL')
  if (url.username || url.password) throw new Error('URL 不允许包含凭据')
}
