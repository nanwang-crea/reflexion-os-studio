import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { safeFetch } from '../dist/agent/tools/web-security.js'
import { resolvePublicAddress } from '../dist/network/egress/web-fetch.js'
import { selectProxy, validateWebUrl } from '../dist/network/egress/proxy.js'
import {
  parseMacProxy,
  parseWindowsProxy,
} from '../dist/network/egress/system-proxy.js'

const proxyKeys = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'npm_config_proxy',
  'npm_config_http_proxy',
  'npm_config_https_proxy',
  'npm_config_no_proxy',
]
function cleanEnv(t) {
  for (const key of proxyKeys.flatMap((key) => [key, key.toUpperCase()])) {
    const old = process.env[key]
    delete process.env[key]
    t.after(() => {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    })
  }
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}
const init = () => ({ signal: AbortSignal.timeout(3000), headers: {} })

test('system settings parse manual HTTP/SOCKS routes and bypasses', () => {
  assert.deepEqual(
    parseMacProxy(
      `HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 7890\nSOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 7891\n0 : *.local`,
    ),
    {
      http: 'http://127.0.0.1:7890',
      https: 'http://[::1]:7890',
      socks: 'socks5h://localhost:7891',
      bypass: ['*.local'],
      automatic: false,
    },
  )
  assert.deepEqual(
    parseWindowsProxy(
      JSON.stringify({
        ProxyEnable: 1,
        ProxyServer:
          'http=localhost:7890;https=localhost:7890;socks=localhost:7891',
        ProxyOverride: '<local>;*.example.com',
      }),
    ),
    {
      http: 'http://localhost:7890',
      https: 'http://localhost:7890',
      socks: 'socks5h://localhost:7891',
      bypass: ['<local>', '*.example.com'],
      automatic: false,
    },
  )
})

test('environment proxy wins, SOCKS resolves remotely, and NO_PROXY forces direct', (t) => {
  cleanEnv(t)
  const url = new URL('https://example.com')
  const system = { https: 'http://localhost:7890', bypass: [] }
  assert.equal(selectProxy(url, system), 'http://localhost:7890/')
  process.env.HTTPS_PROXY = 'socks5://localhost:7891'
  assert.equal(selectProxy(url, system), 'socks5h://localhost:7891')
  process.env.NO_PROXY = 'example.com'
  assert.equal(selectProxy(url, system), '')
  process.env.NO_PROXY = ''
  process.env.HTTPS_PROXY = 'http://user:password@localhost:7890'
  assert.throws(() => selectProxy(url, system), /含凭据/)
})

test('literal private, normalized loopback, metadata and credentials are denied', () => {
  for (const url of [
    'http://127.1',
    'http://0x7f000001',
    'http://10.0.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://198.18.1.75',
    'http://localhost.',
    'http://metadata.google.internal',
    'http://host.local',
    'https://user:password@example.com',
    'file:///tmp/example',
  ]) {
    assert.throws(() => validateWebUrl(new URL(url)), undefined, url)
  }
})

test('HTTP proxy receives original hostname without local target DNS; redirects recheck policy', async (t) => {
  cleanEnv(t)
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    if (req.url.endsWith('/redirect')) {
      res.writeHead(302, { location: 'http://127.0.0.1/private' })
      res.end()
    } else {
      res.end('public fixture')
    }
  })
  process.env.HTTP_PROXY = await listen(t, server)
  const { response } = await safeFetch(
    new URL('http://fake-ip-target.invalid/article'),
    init(),
  )
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString(),
    'public fixture',
  )
  assert.equal(seen[0], 'http://fake-ip-target.invalid/article')
  await assert.rejects(
    safeFetch(new URL('http://fake-ip-target.invalid/redirect'), init()),
    /禁止访问/,
  )
  assert.equal(seen.length, 2)
})

test('HTTPS proxy uses CONNECT with original hostname and preserves cancellation', async (t) => {
  cleanEnv(t)
  let authority
  const server = http.createServer()
  server.on('connect', (req, socket) => {
    authority = req.url
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  process.env.HTTPS_PROXY = await listen(t, server)
  const { response } = await safeFetch(
    new URL('https://fake-ip-target.invalid/article'),
    init(),
  )
  assert.equal(response.status, 502)
  assert.equal(authority, 'fake-ip-target.invalid:443')
  await assert.rejects(
    safeFetch(new URL('https://fake-ip-target.invalid'), {
      headers: {},
      signal: AbortSignal.abort(),
    }),
    { name: 'AbortError' },
  )
})

test('SOCKS5 proxy receives domain rather than a locally resolved Fake-IP', async (t) => {
  cleanEnv(t)
  let target
  const server = net.createServer((socket) => {
    let stage = 0
    socket.on('data', (data) => {
      if (stage === 0) {
        stage++
        socket.write(Buffer.from([5, 0]))
      } else if (stage === 1) {
        stage++
        assert.equal(data[3], 3)
        target = data.subarray(5, 5 + data[4]).toString()
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
      } else
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
        )
    })
  })
  process.env.ALL_PROXY = (await listen(t, server)).replace('http:', 'socks5:')
  const { response } = await safeFetch(
    new URL('http://fake-ip-target.invalid'),
    init(),
  )
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'ok')
  assert.equal(target, 'fake-ip-target.invalid')
})

test('direct DNS rejects Fake-IP and mixed private results, and pins public results', async () => {
  const url = new URL('https://example.com')
  await assert.rejects(
    resolvePublicAddress(url, async () => [
      { address: '198.18.1.75', family: 4 },
    ]),
    /Fake-IP DNS/,
  )
  await assert.rejects(
    resolvePublicAddress(url, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]),
    /禁止访问/,
  )
  assert.deepEqual(
    await resolvePublicAddress(url, async () => [
      { address: '8.8.8.8', family: 4 },
    ]),
    { address: '8.8.8.8', family: 4 },
  )
})

test('system bypass and PAC configuration do not silently change the route', (t) => {
  cleanEnv(t)
  const url = new URL('https://example.com')
  assert.equal(
    selectProxy(url, {
      https: 'http://localhost:7890',
      bypass: ['example.com:443'],
    }),
    '',
  )
  process.env.NO_PROXY = '.example.com'
  assert.equal(
    selectProxy(new URL('https://www.example.com'), {
      https: 'http://localhost:7890',
      bypass: [],
    }),
    '',
  )
  process.env.NO_PROXY = ''
  assert.throws(() => selectProxy(url, { bypass: [], automatic: true }), /PAC/)
  process.env.HTTPS_PROXY = 'not a proxy URL'
  assert.throws(() => selectProxy(url, { bypass: [] }), /代理地址无效/)
})

test('HTTP proxy cancellation interrupts an in-flight response', async (t) => {
  cleanEnv(t)
  const controller = new AbortController()
  const server = http.createServer((_req, res) => {
    res.writeHead(200)
    res.write('partial')
    controller.abort()
  })
  process.env.HTTP_PROXY = await listen(t, server)
  await assert.rejects(
    safeFetch(new URL('http://fake-ip-target.invalid'), {
      headers: {},
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  )
})
