import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { Store } from '../store/index.js'
import { copyPackage } from '../plugins/sources.js'
import { inspectPackage } from '../plugins/package.js'

/** Resolve package roots without following user-controlled directory symlinks. */
export function skillRoot(
  store: Store,
  globalRoot: string,
  projectId: string | null,
  create = false,
): string {
  let root = globalRoot
  if (projectId !== null) {
    const project = store.projects.get(projectId)
    if (!project?.folderPath) throw new Error('项目 Skill 需要绑定工作空间')
    const parent = join(project.folderPath, '.reflexion-os-studio')
    assertDirectory(parent)
    root = join(parent, 'skills')
  }
  assertDirectory(root)
  if (create) mkdirSync(root, { recursive: true })
  return root
}

function assertDirectory(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Skill 目录必须是普通目录，不能是符号链接')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Copy legacy installations once; keep originals recoverable and never overwrite. */
export function migrateSkillLocations(
  store: Store,
  oldRoot: string,
  globalRoot: string,
  builtinIds: ReadonlySet<string>,
): void {
  if (!existsSync(oldRoot)) return
  const candidates = store.plugins
    .list()
    .filter((plugin) => {
      if (!plugin.installPath) return false
      const path = relative(oldRoot, plugin.installPath)
      return path !== '' && !path.startsWith('..') && !isAbsolute(path)
    })
    .map((plugin) => ({
      id: plugin.id,
      projectId: plugin.projectId,
      source: plugin.installPath,
    }))
  const marker = join(oldRoot, '.skills-layout-migrated')
  for (const entry of existsSync(marker)
    ? []
    : readdirSync(oldRoot, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      /^[a-z0-9][a-z0-9-]*$/.test(entry.name) &&
      entry.name !== 'projects'
    ) {
      candidates.push({
        id: entry.name,
        projectId: null,
        source: join(oldRoot, entry.name),
      })
    }
  }
  for (const candidate of candidates) {
    if (!candidate.source || builtinIds.has(candidate.id)) continue
    try {
      const manifest = inspectPackage(candidate.source)
      if (manifest.id !== candidate.id) continue
      const root = skillRoot(store, globalRoot, candidate.projectId, true)
      const target = join(root, candidate.id)
      if (candidate.source !== target && !existsSync(target))
        copyPackage(candidate.source, target)
      const current = store.plugins.get(candidate.id)
      if (
        current &&
        current.projectId === candidate.projectId &&
        inspectPackage(target).id === candidate.id
      ) {
        store.plugins.upsert({
          ...current,
          installPath: target,
          sourceRef:
            current.sourceRef === current.installPath
              ? target
              : current.sourceRef,
        })
      }
    } catch {
      process.stderr.write(
        `[runtime] legacy Skill ${candidate.id} could not be migrated\n`,
      )
    }
  }
  // Existing records retry failed migrations. Never rediscover retained originals
  // after a different package fails, otherwise uninstalled skills reappear.
  writeFileSync(marker, '1\n', 'utf8')
}
