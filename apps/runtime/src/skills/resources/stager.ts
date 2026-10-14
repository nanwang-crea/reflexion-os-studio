import {
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import type {
  PluginRecord,
  SkillPrepared,
} from '@reflexion-os-studio/contracts'
import { copyPackage } from '../../plugins/sources.js'
import { inspectPackage } from '../../plugins/package.js'

/** Only copies validated managed packages. Execution belongs to the existing Shell tool. */
export class SkillResourceStager {
  private readonly snapshots = new Map<
    string,
    { temporary: string; prepared: SkillPrepared; text: Map<string, string> }
  >()

  prepare(
    plugin: PluginRecord,
    managedRoot: string,
    runId: string,
    resource?: string,
  ): SkillPrepared {
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
        const directory = join(temporary, plugin.id)
        copyPackage(source, directory)
        inspectPackage(directory)
        const resources: string[] = []
        const text = new Map<string, string>()
        let textBytes = 0
        const walk = (folder: string, prefix: string): void => {
          for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory()) walk(join(folder, entry.name), name)
            else if (entry.isFile()) {
              resources.push(name)
              const bytes = readFileSync(join(folder, entry.name))
              if (
                bytes.length <= 100000 &&
                textBytes + bytes.length <= 2000000 &&
                !bytes.includes(0)
              ) {
                try {
                  text.set(
                    name,
                    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                  )
                  textBytes += bytes.length
                } catch {
                  /* Binary resources remain available to sandboxed scripts. */
                }
              }
            } else throw new Error('资源必须为普通文件')
          }
        }
        walk(directory, '')
        snapshot = {
          temporary,
          text,
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
        rmSync(temporary, { recursive: true, force: true })
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
    // Scripts never turn this tool into a privileged reader by modifying the snapshot.
    const content = snapshot.text.get(resource)
    if (content === undefined)
      throw new Error('资源过大或为二进制，请通过脚本使用快照文件')
    return { ...snapshot.prepared, resource: { path: resource, content } }
  }

  releaseRun(runId: string): void {
    for (const [key, value] of this.snapshots) {
      if (JSON.parse(key)[0] !== runId) continue
      rmSync(value.temporary, { recursive: true, force: true })
      this.snapshots.delete(key)
    }
  }
  dispose(): void {
    for (const value of this.snapshots.values())
      rmSync(value.temporary, { recursive: true, force: true })
    this.snapshots.clear()
  }
}
