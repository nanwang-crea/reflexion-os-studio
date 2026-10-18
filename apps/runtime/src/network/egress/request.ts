import http from 'node:http'
import https from 'node:https'
import type { ProxyAgent } from 'proxy-agent'
import type { SafeResponse } from './web-fetch.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function requestPinned(
  url: URL,
  resolved: { address: string; family: number } | undefined,
  init: { signal: AbortSignal; headers: Record<string, string> },
  agent?: ProxyAgent,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {
        method: 'GET',
        family: resolved?.family,
        headers: init.headers,
        signal: init.signal,
        ...(agent ? { agent } : {}),
        ...(resolved
          ? {
              lookup: ((_hostname, _options, callback) =>
                callback(
                  null,
                  resolved.address,
                  resolved.family,
                )) as NonNullable<http.RequestOptions['lookup']>,
            }
          : {}),
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
    request.once('error', (error) =>
      reject(
        agent && error.name !== 'AbortError'
          ? new Error(
              `代理网络请求失败（${(error as NodeJS.ErrnoException).code ?? 'connection_error'}），请检查系统代理或环境代理配置`,
            )
          : error,
      ),
    )
    request.end()
  })
}
