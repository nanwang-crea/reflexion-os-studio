import { requireString, type CommandHandler } from './command-utils.js'
import type { MemoryScope } from '@reflexion-os-studio/contracts'

/** A2 Memory 管理命令：列表（供记忆页）、编辑/固定、删除（撤销自动写入）。 */
export const memoryCommandHandlers: Record<string, CommandHandler> = {
  'memory.list': (p, { store }) => {
    const scope =
      p.scope === 'session' || p.scope === 'project' || p.scope === 'user'
        ? (p.scope as MemoryScope)
        : undefined
    const scopeId =
      p.scopeId === undefined
        ? undefined
        : p.scopeId === null
          ? null
          : requireString(p, 'scopeId')
    return { memories: store.memories.list({ scope, scopeId }) }
  },
  'memory.update': (p, { store }) => {
    const id = requireString(p, 'id')
    const content =
      typeof p.content === 'string' && p.content.trim() !== ''
        ? p.content.trim()
        : undefined
    const status =
      p.status === 'active' || p.status === 'pinned' || p.status === 'archived'
        ? p.status
        : undefined
    return { memory: store.memories.update(id, { content, status }) }
  },
  'memory.delete': (p, { store }) => ({
    removed: store.memories.remove(requireString(p, 'id')),
  }),
}
