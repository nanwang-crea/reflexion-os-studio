import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store/index.js'
import { inspectPackage } from './package.js'
import { cleanupTemporary } from './sources.js'

/** Reconciles interrupted atomic package operations before normal discovery. */
export function recoverPluginTransactions(
  pluginsRoot: string,
  store: Store,
): void {
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.')) continue
    const path = join(pluginsRoot, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      cleanupTemporary(path)
      continue
    }
    try {
      if (isDisposable(entry.name)) cleanupTemporary(path)
      else if (entry.name.startsWith('.backup-'))
        recoverBackup(path, pluginsRoot, store)
      else if (entry.name.startsWith('.remove-'))
        recoverRemoval(path, pluginsRoot, store)
    } catch (error) {
      process.stderr.write(
        `[runtime] plugin transaction recovery skipped ${entry.name}: ${String(error)}\n`,
      )
    }
  }
}

function recoverBackup(path: string, root: string, store: Store): void {
  const backup = inspectPackage(path)
  const target = join(root, backup.id)
  if (!existsSync(target)) {
    renameSync(path, target)
    return
  }
  const current = store.plugins.get(backup.id)
  const targetManifest = inspectPackage(target)
  if (current?.version === targetManifest.version) {
    cleanupTemporary(path)
    return
  }
  cleanupTemporary(target)
  renameSync(path, target)
}

function recoverRemoval(path: string, root: string, store: Store): void {
  const manifest = inspectPackage(path)
  const target = join(root, manifest.id)
  if (store.plugins.get(manifest.id) === null) {
    cleanupTemporary(path)
    return
  }
  if (!existsSync(target)) renameSync(path, target)
  else cleanupTemporary(path)
}

function isDisposable(name: string): boolean {
  return ['.stage-', '.source-', '.preview-'].some((prefix) =>
    name.startsWith(prefix),
  )
}
