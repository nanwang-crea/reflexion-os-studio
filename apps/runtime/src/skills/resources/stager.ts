import { mkdtempSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import {
  MAX_SKILL_RESOURCE_PAGE_BYTES,
  SkillResourceReadOptionsSchema,
  type PluginRecord,
  type SkillPrepared,
  type SkillResourcePage,
  type SkillResourceReadOptions,
} from '@reflexion-os-studio/contracts'
import { cleanupTemporaryBestEffort } from '../../plugins/cleanup.js'
import { copyPackage } from '../../plugins/sources.js'
import { inspectPackage } from '../../plugins/package.js'
import { readSnapshotText } from './content.js'
import { fingerprintResource, type ResourceFingerprint } from './files.js'

/** Only copies validated managed packages. Execution belongs to the existing Shell tool. */
export class SkillResourceStager {
  private readonly snapshots = new Map<
    string,
    {
      temporary: string
      prepared: SkillPrepared
      fingerprints: Map<string, ResourceFingerprint>
      pages: Map<string, SkillResourcePage>
    }
  >()

  private readonly pendingCleanup = new Set<string>()

  private cleanup(path: string): void {
    if (cleanupTemporaryBestEffort(path)) this.pendingCleanup.delete(path)
    else this.pendingCleanup.add(path)
  }

  prepare(
    plugin: PluginRecord,
    managedRoot: string,
    runId: string,
    resource?: string,
    options: SkillResourceReadOptions = {},
  ): SkillPrepared {
    options = SkillResourceReadOptionsSchema.parse(options)
    if (!plugin.installPath || !plugin.enabled || plugin.status !== 'enabled')
      throw new Error('Skill 不可用')
    const key = JSON.stringify([runId, plugin.id])
    let snapshot = this.snapshots.get(key)
    if (!snapshot) {
      if (this.snapshots.size >= 32) throw new Error('Skill 临时资源预算已用完')
      if (lstatSync(plugin.installPath).isSymbolicLink())
        throw new Error('Skill 包不能是符号链接')
      const source = realpathSync(plugin.installPath)
      const within = relative(realpathSync(managedRoot), source)
      if (!within || within.startsWith('..') || isAbsolute(within))
        throw new Error('Skill 不在受管目录')
      const manifest = inspectPackage(source)
      if (manifest.id !== plugin.id || manifest.version !== plugin.version)
        throw new Error('Skill 文件已变化，请重新加载技能')
      const temporary = mkdtempSync(join(tmpdir(), 'reflexion-skill-'))
      try {
        const copied = join(temporary, plugin.id)
        copyPackage(source, copied)
        const directory = realpathSync(copied)
        inspectPackage(directory)
        const resources: string[] = []
        const fingerprints = new Map<string, ResourceFingerprint>()
        const walk = (folder: string, prefix: string): void => {
          for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory()) walk(join(folder, entry.name), name)
            else if (entry.isFile()) {
              resources.push(name)
              fingerprints.set(
                name,
                fingerprintResource(join(folder, entry.name)),
              )
            } else throw new Error('资源必须为普通文件')
          }
        }
        walk(directory, '')
        snapshot = {
          temporary,
          fingerprints,
          pages: new Map(),
          prepared: {
            skillId: plugin.id,
            version: manifest.version,
            directory,
            nodeExecutable: process.execPath,
            resources: resources.sort(),
            resource: null,
          },
        }
        this.snapshots.set(key, snapshot)
      } catch (error) {
        this.cleanup(temporary)
        throw error
      }
    }
    if (resource === undefined) return { ...snapshot.prepared }
    if (
      !snapshot.prepared.resources.includes(resource) ||
      resource
        .split('/')
        .some((part) => part.startsWith('.') || /[\\:\x00-\x1f]/.test(part))
    )
      throw new Error('资源路径不存在或越界')
    const cacheKey = JSON.stringify([
      resource,
      options.offset ?? 0,
      options.limit ?? MAX_SKILL_RESOURCE_PAGE_BYTES,
    ])
    let page = snapshot.pages.get(cacheKey)
    if (page === undefined) {
      page = readSnapshotText(
        snapshot.prepared.directory,
        resource,
        snapshot.fingerprints.get(resource)!,
        options,
      )
      // Cache at most 2MB; eviction never prevents an on-demand resource read.
      if (snapshot.pages.size >= 20)
        snapshot.pages.delete(snapshot.pages.keys().next().value!)
      snapshot.pages.set(cacheKey, page)
    }
    return { ...snapshot.prepared, resource: { ...page } }
  }

  releaseRun(runId: string): void {
    for (const [key, value] of this.snapshots) {
      if (JSON.parse(key)[0] !== runId) continue
      this.snapshots.delete(key)
      this.cleanup(value.temporary)
    }
  }
  dispose(): void {
    const paths = new Set(this.pendingCleanup)
    for (const value of this.snapshots.values()) paths.add(value.temporary)
    this.snapshots.clear()
    for (const path of paths) this.cleanup(path)
  }
}
