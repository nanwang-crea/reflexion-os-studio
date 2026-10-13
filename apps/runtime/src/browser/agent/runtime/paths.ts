import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { browserWorkerPaths } from '../paths.js'

export function browserRuntimePaths(dataDir: string) {
  const { worker } = browserWorkerPaths()
  const packaged = worker.endsWith('.mjs')
  const manifest = packaged
    ? join(dirname(worker), 'node_modules', 'playwright', 'package.json')
    : createRequire(import.meta.url).resolve('playwright/package.json')
  const version: unknown = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (typeof version !== 'string' || !/^[a-zA-Z0-9.+-]+$/.test(version))
    throw new Error('runtime-unavailable')
  const cli = join(dirname(manifest), 'cli.js')
  const probe = join(dirname(worker), packaged ? 'probe.mjs' : 'probe.js')
  if (!statSync(cli).isFile() || !statSync(probe).isFile())
    throw new Error('runtime-unavailable')
  const root = join(dataDir, 'agent-browser')
  return {
    version,
    root,
    browsers: join(root, `${version}-${process.platform}-${process.arch}`),
    cli,
    probe,
  }
}
