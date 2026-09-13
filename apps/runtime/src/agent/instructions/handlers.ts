import { requireString, type CommandHandler } from '../../command-utils.js'
import { CommandError } from '../errors.js'
import { getInstruction, saveInstruction } from './service.js'
import type { InstructionKind, InstructionScope } from './paths.js'

function scopeOf(raw: unknown): InstructionScope {
  if (raw === 'global' || raw === 'project') return raw
  throw new CommandError('invalid_request', 'scope 必须是 global 或 project')
}

function kindOf(raw: unknown): InstructionKind {
  if (raw === 'agents' || raw === 'memory') return raw
  throw new CommandError('invalid_request', 'kind 必须是 agents 或 memory')
}

function projectIdOf(p: Record<string, unknown>): string | null {
  return typeof p.projectId === 'string' && p.projectId !== ''
    ? p.projectId
    : null
}

/** 指令页命令：四类文件的读取与保存（写路径均在 instructions/service.ts）。 */
export const instructionsCommandHandlers: Record<string, CommandHandler> = {
  'instructions.get': async (p, { store }) => {
    requireString(p, 'scope')
    // getInstruction 对「存在但不可读」的文件抛错：此处不吞，交由 dispatch 统一映射
    // （CommandError → 业务码；其余 → internal），编辑器不得把不可读当成空。
    return getInstruction({
      store,
      scope: scopeOf(p.scope),
      projectId: projectIdOf(p),
      kind: kindOf(p.kind),
    })
  },
  'instructions.save': async (p, { store }) => {
    requireString(p, 'scope')
    const outcome = await saveInstruction({
      store,
      scope: scopeOf(p.scope),
      projectId: projectIdOf(p),
      kind: kindOf(p.kind),
      content: typeof p.content === 'string' ? p.content : '',
    })
    if (!outcome.ok) throw new CommandError('invalid_request', outcome.message)
    return { ok: true, message: outcome.message }
  },
}
