import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

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
    const address = await resolvePublicAddress(current)
    const response = await requestPinned(current, address, init)
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

async function resolvePublicAddress(
  url: URL,
): Promise<{ address: string; family: number }> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('仅支持 http/https URL')
  if (url.username || url.password) throw new Error('URL 不允许包含凭据')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new Error('禁止访问本机或私有网络地址')
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIp(address))
  )
    throw new Error('禁止访问本机、私有、链路本地或保留网络地址')
  return addresses[0]
}

function requestPinned(
  url: URL,
  resolved: { address: string; family: number },
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        let bodyTruncated = false
        response.on('data', (chunk: Buffer) => {
          const remaining = MAX_RESPONSE_BYTES - size
          if (remaining <= 0) {
            bodyTruncated = true
            return
          }
          const kept = chunk.subarray(0, remaining)
          chunks.push(kept)
          size += kept.byteLength
          if (kept.byteLength < chunk.byteLength) bodyTruncated = true
        })
        response.once('error', reject)
        response.once('end', () => {
          const body = Buffer.concat(chunks)
          resolve({
            ok:
              (response.statusCode ?? 500) >= 200 &&
              (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            statusText: response.statusMessage ?? '',
            bodyTruncated,
            headers: {
              get: (name) => {
                const value = response.headers[name.toLowerCase()]
                return Array.isArray(value) ? value.join(', ') : (value ?? null)
              },
            },
            arrayBuffer: async () =>
              body.buffer.slice(
                body.byteOffset,
                body.byteOffset + body.byteLength,
              ),
          })
        })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

export function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.includes(':')) {
    if (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff')
    )
      return false
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice(7))
    return !normalized.startsWith('2001:db8:')
  }
  const parts = normalized.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false
  const [a, b] = parts
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  )
}
