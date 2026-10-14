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
    private readonly scopedRoot?: (projectId: string | null) => string,
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

  updateFromSource(
    id: string,
    source: PluginInstallSource,
    options: PluginLifecycleOptions,
  ): Promise<PluginRecord> {
    const current = this.store.plugins.get(id)
    if (!current || current.source === 'builtin')
      throw new Error('Skill 不可更新')
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
    let committed = false
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
      const installRoot =
        this.scopedRoot?.(projectId) ??
        (projectId === null
          ? this.pluginsRoot
          : join(this.pluginsRoot, 'projects', projectId))
      mkdirSync(installRoot, { recursive: true })
      stage = this.temporaryPath(`stage-${preview.id}`, installRoot)
      copyPackage(resolved.directory, stage)
      if (standardSkill) {
        writeFileSync(
          join(stage, 'plugin.json'),
          `${JSON.stringify(preview, null, 2)}\n`,
        )
      }
      throwIfAborted(options.signal)
      const manifest = inspectPackage(stage)
      target = join(installRoot, manifest.id)
      mkdirSync(join(target, '..'), { recursive: true })
      options.onProgress?.('committing', 90)
      const latest = updating ? this.store.plugins.get(updating.id) : null
      if (updating && latest?.version !== updating.version)
        throw new Error('Skill 版本已变化，请重试更新')
      if (existsSync(target)) {
        if (updating === null)
          throw new Error(`target already exists: ${manifest.id}`)
        backup = this.temporaryPath(`backup-${manifest.id}`, installRoot)
        renameSync(target, backup)
      }
      renameSync(stage, target)
      stage = null
      committed = true
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
        status: latest?.enabled === false ? 'disabled' : 'enabled',
        installPath: target,
        enabled: latest?.enabled ?? true,
        manifest,
        error: null,
      })
      if (backup !== null) {
        try {
          cleanupTemporary(backup)
        } catch {
          process.stderr.write(
            '[runtime] Skill backup retained for startup cleanup\n',
          )
        }
      }
      return plugin
    } catch (error) {
      if (target !== null && backup !== null && existsSync(backup)) {
        if (existsSync(target)) cleanupTemporary(target)
        renameSync(backup, target)
        backup = null
      } else if (
        committed &&
        target !== null &&
        existsSync(target) &&
        updating === null
      ) {
        cleanupTemporary(target)
      }
      throw error
    } finally {
      cleanupTemporary(sourceTemporary)
      if (stage !== null) cleanupTemporary(stage)
      // A failed rollback must retain the only recoverable copy for startup recovery.
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

  private temporaryPath(label: string, root = this.pluginsRoot): string {
    return join(root, `.${label}-${randomUUID()}`)
  }
}
