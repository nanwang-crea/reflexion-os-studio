import http from 'node:http'
import net from 'node:net'
import type { Socket } from 'node:net'
import { allowedRequest, publicAddress } from './network.js'

/** Ephemeral browser egress only; DNS is pinned before every connection. */
export async function createBrowserProxy(
  origin: string,
  resolveAddress: (host: string) => Promise<string> = publicAddress,
) {
  const target = new URL(origin)
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    if (sockets.size >= 64) {
      socket.destroy()
      return socket
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(20000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    return socket
  }
  let requests = 0
  const server = http.createServer(async (request, response) => {
    try {
      if (++requests > 1000 || closed) throw new Error('denied')
      const raw = request.url ?? ''
      if (
        target.protocol !== 'http:' ||
        !allowedRequest(origin, raw, request.method ?? '')
      )
        throw new Error('denied')
      const url = new URL(raw)
      const address = await resolveAddress(url.hostname)
      if (closed) throw new Error('closed')
      const headers = { ...request.headers, host: url.host }
      delete headers.authorization
      delete headers['proxy-authorization']
      const upstream = http.request(
        {
          hostname: address,
          port: Number(url.port || 80),
          path: url.pathname + url.search,
          method: request.method,
          headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers)
          incoming.pipe(response)
        },
      )
      upstream.on('socket', track)
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      request.on('aborted', () => upstream.destroy())
      upstream.end()
    } catch {
      response.writeHead(403)
      response.end()
    }
  })
  let closed = false
  server.on('connection', track)
  server.on('connect', async (request, client, head) => {
    try {
      if (++requests > 1000 || closed) throw new Error('denied')
      const authority = `${target.hostname}:${target.port || 443}`
      if (target.protocol !== 'https:' || request.url !== authority)
        throw new Error('denied')
      const address = await resolveAddress(target.hostname)
      if (closed) throw new Error('closed')
      const upstream = track(
        net.connect({ host: address, port: Number(target.port || 443) }),
      )
      upstream.once('connect', () => {
        if (closed || client.destroyed) {
          upstream.destroy()
          return
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
    } catch {
      client.destroy()
    }
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('browser_proxy_failed')
  return {
    server: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
