import { isPublicIp } from '../address-policy.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ProxyAgent } from 'proxy-agent'
import { resolveProxy, validateWebUrl } from './proxy.js'
import { requestPinned } from './request.js'

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
    const proxy = await resolveProxy(current)
    const address = proxy ? undefined : await resolvePublicAddress(current)
    const agent = proxy
      ? new ProxyAgent({ getProxyForUrl: () => proxy })
      : undefined
    let response: SafeResponse
    try {
      response = await requestPinned(current, address, init, agent)
    } finally {
      agent?.destroy()
    }
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

export async function resolvePublicAddress(
  url: URL,
  resolve: typeof lookup = lookup,
): Promise<{ address: string; family: number }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname, { all: true, verbatim: true })
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIp(address))
  )
    throw new Error(
      addresses.some(({ address }) => /^198\.(18|19)\./.test(address))
        ? '检测到 Fake-IP DNS（198.18.0.0/15），当前没有可用代理；请启用系统手动代理或配置 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY（支持 SOCKS5），或在代理软件中将该域名加入 fake-ip-filter 后重试'
        : '禁止访问本机、私有、链路本地或保留网络地址',
    )
  return addresses[0]
}
