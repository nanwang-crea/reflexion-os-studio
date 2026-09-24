import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  PluginInstallSource,
  PluginPackageManifest,
  PluginRecord,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import { compareVersions, inspectPackage } from './package.js'
import {
  cleanupTemporary,
  copyPackage,
  resolveInstallSource,
  sourceForUpdate,
} from './sources.js'

export class PluginPackageInstaller {
  constructor(
    private readonly store: Store,
    private readonly pluginsRoot: string,
    private readonly builtinIds: ReadonlySet<string>,
  ) {}

  preview(source: PluginInstallSource): {
    manifest: PluginPackageManifest
    installed: PluginRecord | null
  } {
    const temporary = this.temporaryPath('preview')
    try {
      const resolved = resolveInstallSource(source, this.store, temporary)
      const manifest = inspectPackage(resolved.directory)
      return { manifest, installed: this.store.plugins.get(manifest.id) }
    } finally {
      cleanupTemporary(temporary)
    }
  }

  install(source: PluginInstallSource): PluginRecord {
    return this.installOrUpdate(source, null)
  }

  update(id: string): PluginRecord {
    const current = this.store.plugins.get(id)
    if (!current) throw new Error(`external plugin not found: ${id}`)
    if (current.source === 'builtin') {
      throw new Error('builtin plugins cannot be updated')
    }
    return this.installOrUpdate(
      sourceForUpdate(current.source, current.sourceRef),
      current,
    )
  }

  private installOrUpdate(
    source: PluginInstallSource,
    updating: PluginRecord | null,
  ): PluginRecord {
    const sourceTemporary = this.temporaryPath('source')
    let stage: string | null = null
    let backup: string | null = null
    let target: string | null = null
    try {
      const resolved = resolveInstallSource(source, this.store, sourceTemporary)
      const preview = inspectPackage(resolved.directory)
      this.assertInstallAllowed(preview, updating)

      stage = this.temporaryPath(`stage-${preview.id}`)
      copyPackage(resolved.directory, stage)
      const manifest = inspectPackage(stage)
      target = join(this.pluginsRoot, manifest.id)
      if (existsSync(target)) {
        if (updating === null)
          throw new Error(`target already exists: ${manifest.id}`)
        backup = this.temporaryPath(`backup-${manifest.id}`)
        renameSync(target, backup)
      }
      renameSync(stage, target)
      stage = null
      const plugin = this.store.plugins.upsert({
        id: manifest.id,
        kind: manifest.type,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        source: source.source,
        sourceRef: resolved.sourceRef,
        status: updating?.enabled === false ? 'disabled' : 'enabled',
        installPath: target,
        enabled: updating?.enabled ?? true,
        manifest,
        error: null,
      })
      if (backup !== null) cleanupTemporary(backup)
      return plugin
    } catch (error) {
      if (target !== null && existsSync(target) && backup !== null) {
        cleanupTemporary(target)
        renameSync(backup, target)
      } else if (target !== null && existsSync(target) && updating === null) {
        cleanupTemporary(target)
      }
      throw error
    } finally {
      cleanupTemporary(sourceTemporary)
      if (stage !== null) cleanupTemporary(stage)
      if (backup !== null && existsSync(backup)) cleanupTemporary(backup)
    }
  }

  private assertInstallAllowed(
    manifest: PluginPackageManifest,
    updating: PluginRecord | null,
  ): void {
    if (this.builtinIds.has(manifest.id)) {
      throw new Error(`plugin id conflicts with builtin: ${manifest.id}`)
    }
    const existing = this.store.plugins.get(manifest.id)
    if (updating === null && existing !== null) {
      throw new Error(`plugin id is already installed: ${manifest.id}`)
    }
    if (updating === null) return
    if (manifest.id !== updating.id) {
      throw new Error('updated package id does not match installed plugin')
    }
    if (compareVersions(manifest.version, updating.version) <= 0) {
      throw new Error(
        `update version ${manifest.version} must be newer than ${updating.version}`,
      )
    }
  }

  private temporaryPath(label: string): string {
    return join(this.pluginsRoot, `.${label}-${randomUUID()}`)
  }
}
