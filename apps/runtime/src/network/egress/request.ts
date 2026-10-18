import http from 'node:http'
import https from 'node:https'
import type { SafeResponse } from './web-fetch.js'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function requestWeb(
  url: URL,
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
