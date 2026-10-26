import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { Store } from '../../dist/store/index.js'
import { RuntimeEventBus } from '../../dist/access/events.js'
import { RemoteLiveState } from '../../dist/access/remote/state/live-state.js'
import { RemoteAccessPolicy } from '../../dist/access/remote/auth/policy.js'
import { RuntimeRequestGateway } from '../../dist/access/requests/gateway.js'
import { RemoteAccessService } from '../../dist/access/remote/service.js'
import { dispatchCommand } from '../../dist/handlers.js'

export async function harness(t, webRoot, provider) {
  const directory = await mkdtemp(join(tmpdir(), 'remote-access-test-'))
  const store = new Store(directory)
  const session = store.sessions.create(null, '手机测试会话')
  const other = store.sessions.create(null, '其他会话')
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
  })
  if (!webRoot) {
    webRoot = join(directory, 'web')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await writeFile(
      join(webRoot, 'remote.html'),
      '<!doctype html><p>remote fixture</p>',
    )
    await writeFile(
      join(webRoot, 'assets', 'app-test.js'),
      'window.fixture=true',
    )
  }
  const bus = new RuntimeEventBus()
  const live = new RemoteLiveState()
  bus.subscribe(live.accept)
  const policy = new RemoteAccessPolicy(store)
  const executions = []
  const context = {
    store,
    danger: { leaseFor: () => null },
    agent: {
      listQueue: () => ({ items: [], paused: false }),
      send: (params) => {
        executions.push(params)
        return {
          queued: true,
          messageId: null,
          runId: null,
          queueId: 'test-queue',
          position: 0,
        }
      },
    },
  }
  const calls = []
  const gateway = new RuntimeRequestGateway({
    authorize: policy.authorize,
    report: () => {},
    dispatch: async (method, params) => {
      calls.push({ method, params })
      if (method === 'skill.list') return { skills: [] }
      if (method === 'agent_template.list') return { templates: [] }
      if (method === 'remote.catalog')
        return {
          models: [
            {
              providerId: 'fixture-provider',
              providerName: '测试模型',
              model: 'fixture',
            },
          ],
        }
      return dispatchCommand(method, params, context)
    },
  })
  const service = new RemoteAccessService(
    context,
    gateway,
    bus,
    live,
    policy,
    provider,
    webRoot,
  )
  context.remote = service
  t.after(async () => {
    await service.stop()
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const status = await service.start(session.id, '127.0.0.1')
  const event = (type, fields = {}) => ({
    protocolVersion: '1.0',
    eventId: crypto.randomUUID(),
    scope: 'run',
    runId: run.id,
    seq: 0,
    occurredAt: new Date().toISOString(),
    type,
    ...fields,
  })
  return {
    directory,
    store,
    session,
    other,
    run,
    message,
    service,
    gateway,
    bus,
    calls,
    executions,
    context,
    event,
    status,
  }
}

export function http(
  base,
  path,
  {
    body,
    cookie,
    origin = new URL(base).origin,
    host,
    method = body ? 'POST' : 'GET',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base)
    const req = httpsRequest(
      url,
      {
        rejectUnauthorized: false,
        method,
        headers: {
          Origin: origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(host ? { Host: host } : {}),
        },
      },
      (res) => {
        let content = ''
        res.on('data', (data) => {
          content += data
        })
        res.on('end', () => {
          let json
          try {
            json = JSON.parse(content)
          } catch {}
          resolve({
            status: res.statusCode,
            content,
            json,
            headers: res.headers,
          })
        })
      },
    )
    req.once('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}
export async function paired(h) {
  const invitation = new URLSearchParams(
    new URL(h.status.invitationUrl).hash.slice(1),
  ).get('invitation')
  const result = await http(h.status.origin, 'api/pair', {
    body: { invitation, name: 'test phone' },
  })
  const cookie = result.headers['set-cookie'][0].split(';')[0]
  h.service.resolve(result.json.device.id, true)
  return { cookie, device: result.json.device, invitation }
}
