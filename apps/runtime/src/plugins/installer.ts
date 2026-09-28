import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  PluginInstallSource,
  PluginPackageManifest,
  PluginRecord,
  PluginTaskPhase,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import { compareVersions, inspectPackage } from './package.js'
import {
  cleanupTemporary,
  copyPackage,
  resolveInstallSource,
  sourceForUpdate,
  throwIfAborted,
} from './sources.js'

export interface PluginLifecycleOptions {
  signal?: AbortSignal
  onProgress?: (phase: PluginTaskPhase, progress: number) => void
  onWarning?: (warning: string) => void
}

export class PluginPackageInstaller {
  constructor(
    private readonly store: Store,
    private readonly pluginsRoot: string,
    private readonly builtinIds: ReadonlySet<string>,
  ) {}

  async preview(
    source: PluginInstallSource,
    options: PluginLifecycleOptions,
  ): Promise<{
    manifest: PluginPackageManifest
    installed: PluginRecord | null
  }> {
    const temporary = this.temporaryPath('preview')
    try {
      options.onProgress?.('resolving', 5)
      const resolved = await resolveInstallSource(
        source,
        this.store,
        temporary,
        {
          signal: options.signal,
          onDownloadProgress: (progress) =>
            options.onProgress?.(
              'downloading',
              10 + Math.round(progress * 0.45),
            ),
        },
      )
      throwIfAborted(options.signal)
      options.onProgress?.('validating', 70)
      const manifest = inspectPackage(resolved.directory, options.onWarning)
      return { manifest, installed: this.store.plugins.get(manifest.id) }
    } finally {
      cleanupTemporary(temporary)
    }
  }

  install(
    source: PluginInstallSource,
    options: PluginLifecycleOptions,
  ): Promise<PluginRecord> {
    return this.installOrUpdate(source, null, options)
  }

  update(id: string, options: PluginLifecycleOptions): Promise<PluginRecord> {
    const current = this.store.plugins.get(id)
    if (!current) throw new Error(`external plugin not found: ${id}`)
    if (current.source === 'builtin') {
      throw new Error('builtin plugins cannot be updated')
    }
    const source = sourceForUpdate(current.source, current.sourceRef)
    source.installScope = current.scope
    source.installProjectId = current.projectId ?? undefined
    return this.installOrUpdate(source, current, options)
  }

  private async installOrUpdate(
    source: PluginInstallSource,
    updating: PluginRecord | null,
    options: PluginLifecycleOptions,
  ): Promise<PluginRecord> {
    const sourceTemporary = this.temporaryPath('source')
    let stage: string | null = null
    let backup: string | null = null
    let target: string | null = null
    try {
      options.onProgress?.('resolving', 5)
      const resolved = await resolveInstallSource(
        source,
        this.store,
        sourceTemporary,
        {
          signal: options.signal,
          onDownloadProgress: (progress) =>
            options.onProgress?.(
              'downloading',
              10 + Math.round(progress * 0.45),
            ),
        },
      )
      throwIfAborted(options.signal)
      options.onProgress?.('validating', 60)
      const preview = inspectPackage(resolved.directory, options.onWarning)
      const standardSkill = !existsSync(join(resolved.directory, 'plugin.json'))
      const scope = source.installScope ?? 'global'
      const projectId =
        scope === 'project' ? (source.installProjectId ?? null) : null
      if (scope === 'project' && projectId === null) {
        throw new Error('project-scoped skill requires installProjectId')
      }
      if (projectId !== null && !this.store.projects.get(projectId)) {
        throw new Error(`project not found: ${projectId}`)
      }
      this.assertInstallAllowed(preview, updating, standardSkill)

      options.onProgress?.('staging', 75)
      stage = this.temporaryPath(`stage-${preview.id}`)
      copyPackage(resolved.directory, stage)
      if (standardSkill) {
        writeFileSync(
          join(stage, 'plugin.json'),
          `${JSON.stringify(preview, null, 2)}\n`,
        )
      }
      throwIfAborted(options.signal)
      const manifest = inspectPackage(stage)
      target =
        projectId === null
          ? join(this.pluginsRoot, manifest.id)
          : join(this.pluginsRoot, 'projects', projectId, manifest.id)
      mkdirSync(join(target, '..'), { recursive: true })
      options.onProgress?.('committing', 90)
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
        scope,
        projectId,
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
    standardSkill: boolean,
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
    if (
      compareVersions(manifest.version, updating.version) <=
      (standardSkill ? -1 : 0)
    ) {
      throw new Error(
        `update version ${manifest.version} must be newer than ${updating.version}`,
      )
    }
  }

  private temporaryPath(label: string): string {
    return join(this.pluginsRoot, `.${label}-${randomUUID()}`)
  }
}
