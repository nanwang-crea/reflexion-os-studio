import { BlockList, isIP } from 'node:net'
import { getProxyForUrl } from 'proxy-from-env'
import { isPublicIp } from '../address-policy.js'
import { readSystemProxy, type SystemProxy } from './system-proxy.js'

export function validateWebUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('仅支持 http/https URL')
  if (url.username || url.password) throw new Error('URL 不允许包含凭据')
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal' ||
    (isIP(host) && !isPublicIp(host))
  )
    throw new Error('禁止访问本机、私有、链路本地或保留网络地址')
}

function bypasses(url: URL, patterns: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return patterns.some((pattern) => {
    let rule = pattern.trim().toLowerCase()
    if (!rule) return false
    if (rule.includes('/') && isIP(host)) {
      const [network, prefix] = rule.split('/')
      const family = isIP(network)
      const bits = Number(prefix)
      if (!family || !/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128))
        return false
      const block = new BlockList()
      block.addSubnet(network, bits, family === 4 ? 'ipv4' : 'ipv6')
      return block.check(host, isIP(host) === 4 ? 'ipv4' : 'ipv6')
    }
    const withPort = rule.match(/^(.*):(\d+)$/)
    if (withPort) {
      if (withPort[2] !== port) return false
      rule = withPort[1]
    }
    rule = rule.replace(/^\[|\]$/g, '')
    if (rule === '*') return true
    if (rule === '<local>') return !host.includes('.')
    if (rule.startsWith('*.')) return host.endsWith(rule.slice(1))
    if (rule.startsWith('.'))
      return host === rule.slice(1) || host.endsWith(rule)
    return host === rule
  })
}

function hasEnvironmentProxy(): boolean {
  return [
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'npm_config_proxy',
    'npm_config_http_proxy',
    'npm_config_https_proxy',
  ].some((key) => process.env[key] || process.env[key.toUpperCase()])
}

export function selectProxy(url: URL, system: SystemProxy): string {
  // An explicitly configured environment route (including NO_PROXY) wins over OS settings.
  const envProxy = getProxyForUrl(url.href)
  if (envProxy || hasEnvironmentProxy()) return normalizeProxy(envProxy)
  const noProxy = (process.env.no_proxy ?? process.env.NO_PROXY ?? '').split(
    ',',
  )
  if (bypasses(url, [...system.bypass, ...noProxy])) return ''
  const proxy =
    (url.protocol === 'https:' ? system.https : system.http) ?? system.socks
  if (proxy) return normalizeProxy(proxy)
  if (system.automatic)
    throw new Error(
      'web.fetch 暂不支持系统 PAC/WPAD；请配置 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 手动代理',
    )
  return ''
}

function normalizeProxy(value: string): string {
  if (!value) return ''
  let proxy: URL
  try {
    proxy = new URL(value)
  } catch {
    throw new Error('网络代理地址无效，请检查代理配置')
  }
  if (proxy.username || proxy.password)
    throw new Error('web.fetch 不支持含凭据的代理地址，请使用本机无认证代理')
  // socks5h delegates DNS to the proxy, unlike socks5's local lookup.
  if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks:')
    proxy.protocol = 'socks5h:'
  if (!['http:', 'https:', 'socks5h:', 'socks4a:'].includes(proxy.protocol))
    throw new Error('网络代理协议不支持，请使用 HTTP(S)、SOCKS5 或 SOCKS4a')
  return proxy.href
}

export async function resolveProxy(url: URL): Promise<string> {
  if (hasEnvironmentProxy()) return selectProxy(url, { bypass: [] })
  return selectProxy(url, await readSystemProxy())
}
