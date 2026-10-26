import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat, readdir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, relative, sep } from 'node:path'

export function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}
export async function readJson(
  request: IncomingMessage,
  maximumBytes = 15 * 1024 * 1024,
): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  )
    throw new Error('content_type')
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    size += Buffer.byteLength(part)
    if (size > maximumBytes) throw new Error('request_too_large')
    parts.push(Buffer.from(part))
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** Build a closed manifest; never turn an HTTP path into an arbitrary fs read. */
export async function staticManifest(
  root: string,
): Promise<Map<string, { path: string; type: string }>> {
  const canonicalRoot = await realpath(root)
  const files = new Map<string, { path: string; type: string }>()
  const add = async (path: string, url: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('invalid_web_asset')
    const resolved = await realpath(path)
    const rel = relative(canonicalRoot, resolved)
    if (rel.startsWith(`..${sep}`) || rel === '..')
      throw new Error('invalid_web_asset')
    const extension = path.slice(path.lastIndexOf('.'))
    if (mime[extension])
      files.set(url, { path: resolved, type: mime[extension] })
  }
  await add(join(root, 'remote.html'), '/')
  for (const entry of await readdir(join(root, 'assets'), {
    withFileTypes: true,
  })) {
    if (entry.isFile() && /^[a-zA-Z0-9_.-]+$/.test(entry.name))
      await add(join(root, 'assets', entry.name), `/assets/${entry.name}`)
  }
  return files
}
export async function serveStatic(
  manifest: Awaited<ReturnType<typeof staticManifest>>,
  path: string,
  response: ServerResponse,
): Promise<void> {
  const file = manifest.get(path)
  if (!file) {
    response.writeHead(404)
    response.end()
    return
  }
  const handle = await open(
    file.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  let content: Buffer
  try {
    if (
      !(await handle.stat()).isFile() ||
      (await realpath(file.path)) !== file.path
    )
      throw new Error('invalid_web_asset')
    content = await handle.readFile()
  } finally {
    await handle.close()
  }
  response.writeHead(200, { 'Content-Type': file.type })
  response.end(content)
}

export class RequestLimiter {
  private readonly windows = new Map<string, { since: number; count: number }>()
  allow(key: string, maximum = 120): boolean {
    const now = Date.now()
    let entry = this.windows.get(key)
    if (!entry || now - entry.since > 60_000) {
      if (this.windows.size >= 256)
        this.windows.delete(this.windows.keys().next().value!)
      entry = { since: now, count: 0 }
      this.windows.set(key, entry)
    }
    return ++entry.count <= maximum
  }
}
