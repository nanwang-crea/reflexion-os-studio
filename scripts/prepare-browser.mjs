#!/usr/bin/env node
// Ship fixed official tooling only; Chromium is installed explicitly from Settings.
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'apps', 'runtime')
const require = createRequire(join(runtime, 'package.json'))
const output = join(
  root,
  'apps',
  'desktop',
  'src-tauri',
  'package-resources',
  'browser',
)
if (process.argv.includes('--dev')) {
  console.log('Agent Chromium is downloaded on demand from Settings')
  process.exit(0)
}
await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'node_modules'), { recursive: true })
const copied = new Set()
async function copyPackage(name, from) {
  if (copied.has(name)) return
  const scoped = createRequire(join(from, 'package.json'))
  const source = dirname(scoped.resolve(`${name}/package.json`))
  const manifest = JSON.parse(
    await readFile(join(source, 'package.json'), 'utf8'),
  )
  copied.add(name)
  await cp(source, join(output, 'node_modules', name), {
    recursive: true,
    dereference: true,
  })
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await copyPackage(dependency, source)
  // Only copy optional dependencies actually installed on this build platform.
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      scoped.resolve(`${dependency}/package.json`)
    } catch {
      continue
    }
    await copyPackage(dependency, source)
  }
}
await copyPackage('@playwright/mcp', runtime)
await build({
  entryPoints: [join(runtime, 'src', 'browser', 'agent', 'worker', 'index.ts')],
  outfile: join(output, 'worker.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:*', '@playwright/mcp', 'playwright'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url)",
  },
})
await build({
  entryPoints: [join(runtime, 'src', 'browser', 'agent', 'worker', 'probe.ts')],
  outfile: join(output, 'probe.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node:*', 'playwright'],
})
const version = JSON.parse(
  await readFile(require.resolve('@playwright/mcp/package.json'), 'utf8'),
).version
await writeFile(
  join(output, 'versions.json'),
  JSON.stringify({
    mcp: version,
    playwright: JSON.parse(
      await readFile(require.resolve('playwright/package.json'), 'utf8'),
    ).version,
  }) + '\n',
)
console.log(`Managed Playwright staged: ${output}`)
