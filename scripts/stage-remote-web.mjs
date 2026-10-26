// Stage only the browser entry's dependency graph, not desktop/Monaco resources.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const built = resolve(root, 'apps/desktop/dist-frontend')
const target = resolve(
  root,
  'apps/desktop/src-tauri/package-resources/runtime/web',
)
const manifest = JSON.parse(
  await readFile(resolve(built, '.vite/manifest.json'), 'utf8'),
)
const visited = new Set()
const files = new Set(['remote.html'])
function collect(key) {
  if (visited.has(key)) return
  visited.add(key)
  const entry = manifest[key]
  if (!entry) throw new Error(`missing frontend dependency: ${key}`)
  for (const file of [
    entry.file,
    ...(entry.css ?? []),
    ...(entry.assets ?? []),
  ])
    files.add(file)
  for (const dependency of [
    ...(entry.imports ?? []),
    ...(entry.dynamicImports ?? []),
  ])
    collect(dependency)
}
collect('remote.html')
await rm(target, { recursive: true, force: true })
for (const file of files) {
  const source = resolve(built, file)
  const rel = relative(built, source)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('frontend dependency outside build')
  const destination = resolve(target, file)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination)
}
