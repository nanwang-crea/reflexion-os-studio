import {
  remoteCommandResult,
  remoteEvent,
  remoteHistory,
} from './state/projection.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import {
  JsonRpcRequestSchema,
  RemotePairRequestSchema,
  type RemoteStatus,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../../agent/errors.js'
import type { CommandContext } from '../../command-utils.js'
import { readSessionHistory } from '../../chat/history/snapshot.js'
import type { RuntimeRequestGateway } from '../requests/gateway.js'
import type { RuntimeEventBus } from '../events.js'
import { RemotePairing } from './auth/pairing.js'
import { RemoteAccessPolicy } from './auth/policy.js'
import type { RemoteLiveState } from './state/live-state.js'
import {
  LanHttpsEndpointProvider,
  localAddresses,
  type RemoteEndpoint,
  type RemoteEndpointProvider,
} from './transport/endpoint.js'
import {
  json,
  readJson,
  RequestLimiter,
  serveStatic,
  staticManifest,
} from './transport/http.js'
import { RemoteStreams } from './transport/streams.js'

export function remoteWebRoot(entry = process.argv[1]): string {
  const directory = dirname(resolve(entry))
  return entry.endsWith('runtime.mjs')
    ? join(directory, 'web')
    : resolve(directory, '../../desktop/dist-frontend')
}

export class RemoteAccessService {
  private endpoint?: RemoteEndpoint
  private starting = false
  private generation = 0
  private sessionId: string | null = null
  private readonly pairing = new RemotePairing()
  private readonly limiter = new RequestLimiter()
  private readonly streams: RemoteStreams
  private invitationUrl: string | null = null
  private invitationExpiresAt: string | null = null
  private manifest?: Awaited<ReturnType<typeof staticManifest>>
  constructor(
    private readonly context: CommandContext,
    private readonly gateway: RuntimeRequestGateway,
    bus: RuntimeEventBus,
    private readonly live: RemoteLiveState,
    private readonly policy: RemoteAccessPolicy,
    private readonly provider: RemoteEndpointProvider = new LanHttpsEndpointProvider(),
    private readonly webRoot = remoteWebRoot(),
  ) {
    this.streams = new RemoteStreams(bus, policy, this.pairing)
  }

  status(): RemoteStatus {
    const invitationValid =
      this.invitationExpiresAt !== null &&
      Date.parse(this.invitationExpiresAt) > Date.now()
    return {
      running: !!this.endpoint,
      sessionId: this.sessionId,
      origin: this.endpoint?.baseUrl ?? null,
      addresses: localAddresses(),
      fingerprint: this.endpoint?.fingerprint ?? null,
      invitationUrl: invitationValid ? this.invitationUrl : null,
      invitationExpiresAt: invitationValid ? this.invitationExpiresAt : null,
      devices: this.pairing.list(),
    }
  }
  async start(sessionId: string, address: string): Promise<RemoteStatus> {
    if (this.starting || this.endpoint)
      throw new CommandError('invalid_state', '请先停止已开启的手机接入')
    if (!this.context.store.sessions.get(sessionId))
      throw new CommandError('invalid_request', '会话不存在')
    const generation = ++this.generation
    this.starting = true
    try {
      this.manifest = await staticManifest(this.webRoot)
      const endpoint = await this.provider.open(
        address,
        (request, response) => {
          void this.handle(request, response)
        },
      )
      if (generation !== this.generation) {
        await endpoint.close()
        throw new Error('cancelled')
      }
      const published = new URL(endpoint.baseUrl)
      if (
        published.protocol !== 'https:' ||
        !published.pathname.endsWith('/') ||
        published.username ||
        published.password ||
        published.search ||
        published.hash
      ) {
        await endpoint.close()
        throw new Error('invalid_endpoint')
      }
      this.endpoint = endpoint
      this.sessionId = sessionId
      return this.invite()
    } catch {
      throw new CommandError(
        'unavailable',
        '无法开启手机接入，请确认前端已构建、网络地址有效且端口可用',
      )
    } finally {
      this.starting = false
    }
  }
  invite(): RemoteStatus {
    if (!this.endpoint)
      throw new CommandError('invalid_state', '请先开启手机接入')
    const invitation = this.pairing.invite()
    const url = new URL(this.endpoint.baseUrl)
    url.hash = new URLSearchParams({
      invitation: invitation.invitation,
    }).toString()
    this.invitationUrl = url.href
    this.invitationExpiresAt = invitation.expiresAt
    return this.status()
  }
  resolve(id: string, approved: boolean): boolean {
    return this.pairing.resolve(id, approved)
  }
  revoke(id: string): boolean {
    const removed = this.pairing.revoke(id)
    this.streams.closeDevice(id)
    return removed
  }
  async stop(): Promise<void> {
    this.generation++
    const endpoint = this.endpoint
    this.endpoint = undefined
    this.sessionId = null
    this.invitationUrl = null
    this.invitationExpiresAt = null
    this.pairing.clear()
    this.streams.close()
    await endpoint?.close()
  }
  private snapshot(sessionId: string) {
    const snapshot = this.live.snapshot((event) =>
      this.policy.eventBelongs(event, sessionId),
    )
    return { ...snapshot, events: snapshot.events.map(remoteEvent) }
  }
  private credential(request: IncomingMessage): string {
    return (
      request.headers.cookie
        ?.split(';')
        .map((item) => item.trim())
        .find((item) => item.startsWith('__Secure-reflexion-device='))
        ?.slice('__Secure-reflexion-device='.length) ?? ''
    )
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    )
    try {
      const endpoint = this.endpoint
      const sessionId = this.sessionId
      if (!endpoint || !sessionId) {
        json(response, 503, { error: 'unavailable' })
        return
      }
      const base = new URL(endpoint.baseUrl)
      if (
        request.headers.host !== base.host ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== base.origin)
      ) {
        json(response, 403, { error: 'origin' })
        return
      }
      if (!this.limiter.allow('global', 14400)) {
        json(response, 429, { error: 'rate_limit' })
        return
      }
      const url = new URL(request.url ?? '/', base)
      if (!url.pathname.startsWith(base.pathname)) {
        json(response, 404, {})
        return
      }
      const path = '/' + url.pathname.slice(base.pathname.length)
      if (
        (path === '/api/pair' || !path.startsWith('/api/')) &&
        !this.limiter.allow(`public:${request.socket.remoteAddress ?? ''}`, 600)
      ) {
        json(response, 429, { error: 'rate_limit' })
        return
      }
      if (request.method === 'POST' && request.headers.origin !== base.origin) {
        json(response, 403, { error: 'origin' })
        return
      }
      if (request.method === 'POST' && path === '/api/pair') {
        const input = RemotePairRequestSchema.parse(
          await readJson(request, 4096),
        )
        const paired = this.pairing.pair(input.invitation, input.name)
        this.invitationUrl = null
        this.invitationExpiresAt = null
        response.setHeader(
          'Set-Cookie',
          `__Secure-reflexion-device=${paired.credential}; HttpOnly; Secure; SameSite=Strict; Path=${base.pathname}; Max-Age=28800`,
        )
        json(response, 200, { device: paired.device, sessionId })
        return
      }
      if (request.method === 'GET' && path === '/api/pair') {
        json(response, 200, {
          device: this.pairing.authenticate(this.credential(request), false),
          sessionId,
        })
        return
      }
      if (path.startsWith('/api/')) {
        const credential = this.credential(request)
        const device = this.pairing.authenticate(credential)
        if (!this.limiter.allow(`device:${device.id}`, 1200)) {
          json(response, 429, { error: 'rate_limit' })
          return
        }
        if (!this.context.store.sessions.get(sessionId))
          throw new Error('session_deleted')
        if (request.method === 'GET' && path === '/api/events') {
          const dangerLease = this.context.danger.leaseFor(sessionId)
          this.streams.open(response, credential, sessionId, () => ({
            type: 'snapshot',
            dangerLease,
            history: remoteHistory(
              readSessionHistory(this.context.store, { sessionId }),
            ),
            ...this.snapshot(sessionId),
          }))
          return
        }
        if (request.method === 'POST' && path === '/api/rpc') {
          const rpc = JsonRpcRequestSchema.parse(await readJson(request))
          if (typeof rpc.id === 'string' && rpc.id.length > 256)
            throw new Error('invalid_id')
          const result = await this.gateway.execute(rpc, {
            kind: 'device',
            deviceId: device.id,
            sessionId,
          })
          if (!result.error)
            result.result = remoteCommandResult(rpc.method, result.result)
          json(response, 200, result)
          return
        }
        json(response, 404, {})
        return
      }
      if (request.method !== 'GET' || !this.manifest) {
        json(response, 404, {})
        return
      }
      await serveStatic(this.manifest, path, response)
    } catch {
      if (!response.headersSent)
        json(response, 403, { error: '请求被拒绝、连接已过期或数据无效' })
      else response.destroy()
    }
  }
}
