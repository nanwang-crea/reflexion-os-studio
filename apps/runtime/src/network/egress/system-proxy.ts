import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const command = async (file: string, args: string[]) =>
  (await execute(file, args, { timeout: 1500, maxBuffer: 64 * 1024 })).stdout

export type SystemProxy = {
  http?: string
  https?: string
  socks?: string
  bypass: string[]
  automatic?: boolean
}

export function parseMacProxy(text: string): SystemProxy {
  const value = (key: string) =>
    text.match(new RegExp(`^\\s*${key} : (.+)$`, 'm'))?.[1]?.trim()
  const endpoint = (key: string) => {
    if (value(`${key}Enable`) !== '1') return undefined
    return proxyEndpoint(
      value(`${key}Proxy`),
      value(`${key}Port`),
      key === 'SOCKS',
    )
  }
  return {
    http: endpoint('HTTP'),
    https: endpoint('HTTPS'),
    socks: endpoint('SOCKS'),
    bypass: [...text.matchAll(/^\s*\d+ : (.+)$/gm)].map((match) => match[1]),
    automatic:
      value('ProxyAutoConfigEnable') === '1' ||
      value('ProxyAutoDiscoveryEnable') === '1',
  }
}

export function parseWindowsProxy(text: string): SystemProxy {
  const settings = JSON.parse(text) as {
    ProxyEnable?: number
    ProxyServer?: string
    ProxyOverride?: string
    AutoConfigURL?: string
  }
  const result: SystemProxy = {
    bypass: (settings.ProxyOverride ?? '').split(';').filter(Boolean),
    automatic: Boolean(settings.AutoConfigURL),
  }
  if (!settings.ProxyEnable || !settings.ProxyServer) return result
  for (const entry of settings.ProxyServer.split(';')) {
    const parts = entry.split('=')
    if (parts.length === 1) {
      result.http = result.https = `http://${parts[0]}`
    } else if (parts[0] === 'http' || parts[0] === 'https') {
      result[parts[0]] = `http://${parts[1]}`
    } else if (parts[0] === 'socks') result.socks = `socks5h://${parts[1]}`
  }
  return result
}

function proxyEndpoint(host?: string, port?: string, socks = false) {
  if (!host || !port || !/^\d+$/.test(port)) return undefined
  const authority =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${socks ? 'socks5h' : 'http'}://${authority}:${port}`
}

/** Read manual OS network settings only; never browser profiles or credentials. */
export async function readSystemProxy(): Promise<SystemProxy> {
  try {
    if (process.platform === 'darwin')
      return parseMacProxy(await command('/usr/sbin/scutil', ['--proxy']))
    if (process.platform === 'win32')
      return parseWindowsProxy(
        await command('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress",
        ]),
      )
    if (process.platform === 'linux') {
      const get = (schema: string, key: string) =>
        command('gsettings', ['get', `org.gnome.system.proxy${schema}`, key])
      const mode = (await get('', 'mode')).trim()
      if (mode !== "'manual'")
        return { bypass: [], automatic: mode === "'auto'" }
      const entries = await Promise.all(
        ['http', 'https', 'socks'].map(async (name) => {
          const [host, port] = await Promise.all([
            get(`.${name}`, 'host'),
            get(`.${name}`, 'port'),
          ])
          return [
            name,
            proxyEndpoint(
              host.trim().replace(/^'|'$/g, ''),
              port.trim(),
              name === 'socks',
            ),
          ]
        }),
      )
      const bypass = [
        ...(await get('', 'ignore-hosts')).matchAll(/'([^']+)'/g),
      ].map((match) => match[1])
      return { ...Object.fromEntries(entries), bypass }
    }
  } catch {
    // Headless Linux / unavailable OS APIs: environment proxy remains available.
  }
  return { bypass: [] }
}
