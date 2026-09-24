import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginRecord } from '@reflexion-os-studio/contracts'
import { ResourceEventEmitter, type EventNotifier } from '../events.js'
import type { Store } from '../store/index.js'
import { SkillRegistry } from './registry.js'
import {
  assertCompatible,
  assertSkillFileIsSafe,
  parseSkillFile,
} from './manifest.js'
import {
  assertTreeHasNoSymlinks,
  copyDirectory,
  resolveWorkspaceSource,
} from './workspace-installer.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Owns discovery and lifecycle for declarative skill plugins. */
export class SkillPluginService {
  readonly registry: SkillRegistry
  readonly skillsRoot: string
  private readonly emitters = new Map<string, ResourceEventEmitter>()
  private readonly builtinIds: ReadonlySet<string>

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly notify: EventNotifier,
  ) {
    this.registry = createBuiltinRegistry()
    this.builtinIds = new Set(this.registry.list().map((skill) => skill.id))
    this.skillsRoot = join(dataDir, 'skills')
    mkdirSync(this.skillsRoot, { recursive: true })
    this.rescan()
  }

  list(): PluginRecord[] {
    const now = new Date(0).toISOString()
    const builtins = this.registry.list().flatMap((manifest) => {
      if (!this.builtinIds.has(manifest.id)) return []
      return [
        {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          kind: 'skill' as const,
          source: 'builtin' as const,
          sourceRef: null,
          status: 'enabled' as const,
          installPath: null,
          enabled: true,
          compat: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        },
      ]
    })
    return [...builtins, ...this.store.plugins.list()]
  }

  installFromWorkspace(projectId: string, workspacePath: string): PluginRecord {
    const project = this.store.projects.get(projectId)
    if (!project?.folderPath) throw new Error(`project not found: ${projectId}`)
    const source = resolveWorkspaceSource(project.folderPath, workspacePath)
    const sourceDirectory = lstatSync(source).isDirectory()
      ? source
      : dirname(source)
    const sourceSkillFile = lstatSync(source).isDirectory()
      ? join(source, 'SKILL.md')
      : source
    if (basename(sourceSkillFile) !== 'SKILL.md') {
      throw new Error('path must point to a skill directory or SKILL.md')
    }
    assertTreeHasNoSymlinks(sourceDirectory)
    const parsed = parseSkillFile(sourceSkillFile)
    assertCompatible(parsed.compat)
    const id = parsed.definition.manifest.id
    if (this.builtinIds.has(id) || this.store.plugins.get(id)) {
      throw new Error(`plugin id is already installed: ${id}`)
    }

    const temporary = join(this.skillsRoot, `.install-${randomUUID()}`)
    const target = join(this.skillsRoot, id)
    let moved = false
    try {
      copyDirectory(sourceDirectory, temporary)
      const copied = parseSkillFile(join(temporary, 'SKILL.md'))
      if (copied.definition.manifest.id !== id) {
        throw new Error('copied manifest id changed during installation')
      }
      if (existsSync(target)) throw new Error(`target already exists: ${id}`)
      renameSync(temporary, target)
      moved = true
      const plugin = this.store.plugins.upsert({
        ...copied.definition.manifest,
        kind: 'skill',
        source: 'dir',
        sourceRef: `${projectId}:${workspacePath}`,
        status: 'enabled',
        installPath: target,
        enabled: true,
        compat: copied.compat,
        error: null,
      })
      this.reloadRegistry()
      this.emit(plugin)
      return plugin
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true })
      if (moved) rmSync(target, { recursive: true, force: true })
      throw error
    }
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
    if (current.installPath !== null) {
      const target = resolve(current.installPath)
      const root = resolve(this.skillsRoot)
      if (dirname(target) !== root || basename(target) !== id) {
        throw new Error(`refusing to remove unmanaged plugin path: ${target}`)
      }
      rmSync(target, { recursive: true, force: true })
    }
    const removed = this.store.plugins.remove(id)
    this.reloadRegistry()
    if (removed) this.emit(null, id)
    return removed
  }

  rescan(): PluginRecord[] {
    const seen = new Set<string>()
    for (const entry of readdirSync(this.skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      const installPath = join(this.skillsRoot, entry.name)
      seen.add(entry.name)
      const existing = this.store.plugins.get(entry.name)
      if (this.builtinIds.has(entry.name)) {
        process.stderr.write(
          `[runtime] ignoring external skill ${entry.name}: id conflicts with builtin\n`,
        )
        continue
      }
      try {
        assertSkillFileIsSafe(installPath)
        const parsed = parseSkillFile(join(installPath, 'SKILL.md'))
        if (parsed.definition.manifest.id !== entry.name) {
          throw new Error('manifest id must match its directory name')
        }
        assertCompatible(parsed.compat)
        this.store.plugins.upsert({
          ...parsed.definition.manifest,
          kind: 'skill',
          source: existing?.source ?? 'dir',
          sourceRef: existing?.sourceRef ?? null,
          status: existing?.enabled === false ? 'disabled' : 'enabled',
          installPath,
          enabled: existing?.enabled ?? true,
          compat: parsed.compat,
          error: null,
        })
      } catch (error) {
        this.store.plugins.upsert({
          id: entry.name,
          kind: 'skill',
          version: existing?.version ?? '0.0.0',
          name: existing?.name ?? entry.name,
          description: existing?.description ?? 'Invalid skill plugin',
          source: existing?.source ?? 'dir',
          sourceRef: existing?.sourceRef ?? null,
          status: 'invalid',
          installPath,
          enabled: false,
          compat: existing?.compat ?? null,
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
          parseSkillFile(join(plugin.installPath, 'SKILL.md')).definition,
        )
      } catch (error) {
        process.stderr.write(
          `[runtime] skill plugin ${plugin.id} could not be loaded: ${String(error)}\n`,
        )
      }
    }
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
    emitter.next({
      type: 'plugin.changed',
      pluginId: id,
      plugin,
    })
  }
}

function createBuiltinRegistry(): SkillRegistry {
  // Lazy import would complicate deterministic startup; keep builtins in one factory.
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
