import { X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'
import type { RequestListener } from 'node:http'
import { networkInterfaces } from 'node:os'
import { generate } from 'selfsigned'

/** Public relays can publish a path-prefixed HTTPS URL and own an outbound tunnel.
 * They must authenticate the computer, preserve end-to-end confidentiality, and
 * deliver normalized HTTP requests; forwarding headers are never trusted here.
 */
export interface RemoteEndpoint {
  baseUrl: string
  fingerprint: string | null
  close: () => Promise<void>
}
export interface RemoteEndpointProvider {
  open(address: string, listener: RequestListener): Promise<RemoteEndpoint>
}
export function localAddresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address),
      ),
    ),
    '127.0.0.1',
  ]
}

/** LAN is one endpoint implementation, independent of pairing and commands. */
export class LanHttpsEndpointProvider implements RemoteEndpointProvider {
  async open(
    address: string,
    listener: RequestListener,
  ): Promise<RemoteEndpoint> {
    if (!localAddresses().includes(address))
      throw new Error('请选择本机 IPv4 地址')
    const certificate = await generate(
      [{ name: 'commonName', value: 'ReflexionOS local connection' }],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: new Date(Date.now() - 60_000),
        notAfterDate: new Date(Date.now() + 24 * 3600_000),
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 7, ip: address }] },
        ],
      },
    )
    const server = createServer(
      {
        key: certificate.private,
        cert: certificate.cert,
        minVersion: 'TLSv1.2',
      },
      listener,
    )
    server.maxConnections = 32
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, address, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', () => {
      /* Listener errors cannot escape into the Agent. */
    })
    const bound = server.address()
    if (!bound || typeof bound === 'string') throw new Error('无法获取监听地址')
    return {
      baseUrl: `https://${address}:${bound.port}/`,
      fingerprint: new X509Certificate(certificate.cert).fingerprint256,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    }
  }
}
