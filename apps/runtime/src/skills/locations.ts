import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store/index.js'

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
