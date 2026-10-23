import { randomUUID } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { PluginRecord } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { cleanupTemporary } from '../../plugins/sources.js'
import { skillRoot } from '../locations.js'

/** DB deletion commits the uninstall; disposal failures remain quarantined. */
export function uninstallSkill(
  store: Store,
  pluginsRoot: string,
  plugin: PluginRecord,
): void {
  const root = skillRoot(store, pluginsRoot, plugin.projectId)
  const target =
    plugin.installPath === null ? null : resolve(plugin.installPath)
  if (
    target !== null &&
    (relative(resolve(root), target) !== plugin.id ||
      basename(target) !== plugin.id)
  ) {
    throw new Error(`refusing to remove unmanaged plugin path: ${target}`)
  }
  const quarantine = join(root, `.remove-${plugin.id}-${randomUUID()}`)
  let moved = false
  try {
    if (target !== null && existsSync(target)) {
      renameSync(target, quarantine)
      moved = true
    }
    if (!store.plugins.remove(plugin.id))
      throw new Error(`plugin could not be removed: ${plugin.id}`)
  } catch (error) {
    if (moved && target !== null && !existsSync(target)) {
      try {
        renameSync(quarantine, target)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Skill 卸载失败，隔离目录恢复也失败',
          { cause: error },
        )
      }
    }
    throw error
  }
  try {
    cleanupTemporary(quarantine)
  } catch {
    // Startup recovery retries .remove-* cleanup, including partially removed packages.
    process.stderr.write(
      `[runtime] skill removal cleanup deferred (${plugin.id})\n`,
    )
  }
}
