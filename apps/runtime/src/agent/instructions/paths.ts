import { join } from 'node:path'
import type { Store } from '../../store/index.js'
import { resolveDataDir } from '../../store/shared.js'

export type InstructionScope = 'global' | 'project'
export type InstructionKind = 'agents' | 'memory'

/**
 * 四类指令/记忆文件的唯一路径解析。
 * AGENTS.md（项目级）在用户仓库根——只读注入，remember 永不写它；
 * MEMORY.md 全部在应用数据目录（项目级按 <dataDir>/memories/<projectId>/
 * 隔离，与资产存储 <dataDir>/assets/<projectId> 同构），不污染 git。
 */
export function instructionPath(
  store: Store,
  scope: InstructionScope,
  kind: InstructionKind,
  projectId: string | null,
): string | null {
  const dataDir = resolveDataDir()
  if (kind === 'agents') {
    if (scope === 'global') return join(dataDir, 'AGENTS.md')
    if (projectId === null) return null
    const project = store.projects.get(projectId)
    if (!project || project.folderPath === '') return null
    return join(project.folderPath, 'AGENTS.md')
  }
  if (scope === 'global') return join(dataDir, 'MEMORY.md')
  if (projectId === null) return null
  return join(dataDir, 'memories', projectId, 'MEMORY.md')
}
