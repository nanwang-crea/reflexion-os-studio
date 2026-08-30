import type { Memory } from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/** 记忆列表；scope/scopeId 缺省返回全部（不含 archived 历史版本）。 */
export function listMemories(filter?: {
  scope?: 'session' | 'project' | 'user'
  scopeId?: string | null
}): Promise<{ memories: Memory[] }> {
  return request<{ memories: Memory[] }>('memory.list', filter ?? {})
}

/** 编辑内容 / 固定与取消固定（status: pinned|active）。 */
export function updateMemory(input: {
  id: string
  content?: string
  status?: 'active' | 'pinned' | 'archived'
}): Promise<{ memory: Memory | null }> {
  return request<{ memory: Memory | null }>('memory.update', input)
}

export function deleteMemory(id: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('memory.delete', { id })
}
