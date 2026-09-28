import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  PluginPackageManifestSchema,
  type PluginInstallSource,
  type PluginPackageManifest,
  type PluginRecord,
  type PluginTask,
} from '@reflexion-os-studio/contracts'
import { ResourceEventEmitter, type EventNotifier } from '../events.js'
import type { Store } from '../store/index.js'
import {
  loadSkillPackage,
  packageManifestForBuiltin,
} from '../plugins/package.js'
import { cleanupTemporary } from '../plugins/sources.js'
import { PluginPackageInstaller } from '../plugins/installer.js'
import { migrateLegacySkills } from '../plugins/legacy-migration.js'
import { recoverPluginTransactions } from '../plugins/recovery.js'
import { PluginTaskManager } from '../plugins/tasks.js'
import { SkillRegistry } from './registry.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Owns discovery and lifecycle for declarative skill plugins. */
export class SkillPluginService {
  readonly registry: SkillRegistry
  readonly pluginsRoot: string
  private readonly emitters = new Map<string, ResourceEventEmitter>()
  private readonly builtinManifests = new Map<string, PluginPackageManifest>()
  private readonly installer: PluginPackageInstaller
  private readonly tasks: PluginTaskManager

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly notify: EventNotifier,
  ) {
    this.registry = createBuiltinRegistry()
    for (const definition of BUILTIN_SKILLS) {
      const manifest = packageManifestForBuiltin(definition)
      this.builtinManifests.set(manifest.id, manifest)
    }
    this.pluginsRoot = join(dataDir, 'plugins')
    mkdirSync(this.pluginsRoot, { recursive: true })
    const builtinIds = new Set(this.builtinManifests.keys())
    migrateLegacySkills(join(dataDir, 'skills'), this.pluginsRoot, builtinIds)
    recoverPluginTransactions(this.pluginsRoot, this.store)
    this.installer = new PluginPackageInstaller(
      this.store,
      this.pluginsRoot,
      builtinIds,
    )
    this.tasks = new PluginTaskManager(this.installer, this.notify, (id) => {
      this.reloadRegistry()
      const plugin = this.store.plugins.get(id)
      if (plugin) this.emit(plugin)
    })
    this.rescan()
  }

  list(): PluginRecord[] {
    const now = new Date(0).toISOString()
    const builtins = [...this.builtinManifests.values()].map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      kind: manifest.type,
      source: 'builtin' as const,
      sourceRef: null,
      scope: 'global' as const,
      projectId: null,
      status: 'enabled' as const,
      installPath: null,
      enabled: true,
      manifest,
      error: null,
      createdAt: now,
      updatedAt: now,
    }))
    return [...builtins, ...this.store.plugins.list()]
  }

  preview(source: PluginInstallSource): PluginTask {
    return this.tasks.startPreview(source)
  }

  install(source: PluginInstallSource): PluginTask {
    return this.tasks.startInstall(source)
  }

  update(id: string): PluginTask {
    return this.tasks.startUpdate(id)
  }

  listTasks(): PluginTask[] {
    return this.tasks.list()
  }

  cancelTask(id: string): PluginTask {
    return this.tasks.cancel(id)
  }

  projectDeleted(projectId: string): void {
    cleanupTemporary(join(this.pluginsRoot, 'projects', projectId))
    this.reloadRegistry()
  }

  toggle(id: string, enabled: boolean): PluginRecord {
    const current = this.store.plugins.get(id)
    if (!current) throw new Error(`external plugin not found: ${id}`)
    if (current.status === 'invalid') {
      throw new Error(`invalid plugin cannot be enabled: ${id}`)
    }
    const updated = this.store.plugins.setEnabled(id, enabled)
    if (!updated) throw new Error(`plugin not found: ${id}`)
    this.reloadRegistry()
    this.emit(updated)
    return updated
  }

  uninstall(id: string): boolean {
    const current = this.store.plugins.get(id)
    if (!current) return false
    const target = this.assertManagedInstallPath(current)
    const quarantine = this.temporaryPath(`remove-${id}`)
    let moved = false
    try {
      if (target !== null && existsSync(target)) {
        renameSync(target, quarantine)
        moved = true
      }
      const removed = this.store.plugins.remove(id)
      if (!removed) throw new Error(`plugin could not be removed: ${id}`)
      cleanupTemporary(quarantine)
      this.reloadRegistry()
      this.emit(null, id)
      return true
    } catch (error) {
      if (moved && target !== null && !existsSync(target)) {
        renameSync(quarantine, target)
      }
      throw error
    }
  }

  rescan(): PluginRecord[] {
    const seen = new Set<string>()
    for (const entry of readdirSync(this.pluginsRoot, {
      withFileTypes: true,
    })) {
      if (entry.name === 'projects') continue
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      const installPath = join(this.pluginsRoot, entry.name)
      seen.add(entry.name)
      const existing = this.store.plugins.get(entry.name)
      if (this.builtinManifests.has(entry.name)) continue
      try {
        const loaded = loadSkillPackage(installPath)
        if (loaded.manifest.id !== entry.name) {
          throw new Error('manifest id must match its directory name')
        }
        this.store.plugins.upsert({
          id: loaded.manifest.id,
          kind: loaded.manifest.type,
          version: loaded.manifest.version,
          name: loaded.manifest.name,
          description: loaded.manifest.description,
          source: existing?.source ?? 'local',
          sourceRef: existing?.sourceRef ?? installPath,
          scope: existing?.scope ?? 'global',
          projectId: existing?.projectId ?? null,
          status: existing?.enabled === false ? 'disabled' : 'enabled',
          installPath,
          enabled: existing?.enabled ?? true,
          manifest: loaded.manifest,
          error: null,
        })
      } catch (error) {
        const manifest = existing?.manifest ?? invalidManifest(entry.name)
        this.store.plugins.upsert({
          id: entry.name,
          kind: manifest.type,
          version: manifest.version,
          name: manifest.name,
          description: manifest.description,
          source: existing?.source ?? 'local',
          sourceRef: existing?.sourceRef ?? installPath,
          scope: existing?.scope ?? 'global',
          projectId: existing?.projectId ?? null,
          status: 'invalid',
          installPath,
          enabled: false,
          manifest,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const plugin of this.store.plugins.list()) {
      if (
        plugin.scope !== 'project' ||
        plugin.installPath === null ||
        !existsSync(plugin.installPath)
      ) {
        continue
      }
      seen.add(plugin.id)
      try {
        const loaded = loadSkillPackage(plugin.installPath)
        if (loaded.manifest.id !== plugin.id) {
          throw new Error('manifest id must match its directory name')
        }
        this.store.plugins.upsert({
          ...plugin,
          version: loaded.manifest.version,
          name: loaded.manifest.name,
          description: loaded.manifest.description,
          status: plugin.enabled ? 'enabled' : 'disabled',
          manifest: loaded.manifest,
          error: null,
        })
      } catch (error) {
        this.store.plugins.upsert({
          ...plugin,
          status: 'invalid',
          enabled: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const plugin of this.store.plugins.list()) {
      if (plugin.kind !== 'skill' || seen.has(plugin.id)) continue
      this.store.plugins.upsert({
        ...plugin,
        status: 'invalid',
        enabled: false,
        error: 'plugin directory is missing',
      })
    }
    this.reloadRegistry()
    return this.list()
  }

  private reloadRegistry(): void {
    this.registry.clearExternal()
    for (const plugin of this.store.plugins.list()) {
      if (!plugin.enabled || plugin.status !== 'enabled') continue
      if (plugin.kind !== 'skill' || plugin.installPath === null) continue
      try {
        this.registry.registerExternal(
          loadSkillPackage(plugin.installPath).definition,
          { scope: plugin.scope, projectId: plugin.projectId },
        )
      } catch (error) {
        process.stderr.write(
          `[runtime] skill plugin ${plugin.id} could not be loaded: ${String(error)}\n`,
        )
      }
    }
  }

  private assertManagedInstallPath(plugin: PluginRecord): string | null {
    if (plugin.installPath === null) return null
    const target = resolve(plugin.installPath)
    const root = resolve(this.pluginsRoot)
    const relativeTarget = relative(root, target)
    const expected =
      plugin.scope === 'project' && plugin.projectId !== null
        ? join('projects', plugin.projectId, plugin.id)
        : plugin.id
    if (relativeTarget !== expected || basename(target) !== plugin.id) {
      throw new Error(`refusing to remove unmanaged plugin path: ${target}`)
    }
    return target
  }

  private temporaryPath(label: string): string {
    return join(this.pluginsRoot, `.${label}-${randomUUID()}`)
  }

  private emit(plugin: PluginRecord | null, id = plugin?.id ?? ''): void {
    let emitter = this.emitters.get(id)
    if (!emitter) {
      emitter = new ResourceEventEmitter(
        { scope: 'plugin', pluginId: id },
        this.notify,
      )
      this.emitters.set(id, emitter)
    }
    emitter.next({ type: 'plugin.changed', pluginId: id, plugin })
  }
}

function invalidManifest(id: string): PluginPackageManifest {
  return PluginPackageManifestSchema.parse({
    manifestVersion: 1,
    id,
    name: id,
    version: '0.0.0',
    description: 'Invalid skill plugin',
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: { filesystem: 'none', network: false, shell: false },
    skill: { tools: [], argumentHint: null },
  })
}

function createBuiltinRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  for (const skill of BUILTIN_SKILLS) registry.register(skill)
  return registry
}

import { CODE_REVIEW_SKILL } from './builtin/code-review.js'
import { VERIFY_FIX_SKILL } from './builtin/verify-fix.js'
import { WEB_RESEARCH_SKILL } from './builtin/web-research.js'
import { WORKSPACE_REPORT_SKILL } from './builtin/workspace-report.js'

const BUILTIN_SKILLS = [
  CODE_REVIEW_SKILL,
  VERIFY_FIX_SKILL,
  WEB_RESEARCH_SKILL,
  WORKSPACE_REPORT_SKILL,
]
