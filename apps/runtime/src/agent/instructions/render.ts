import type { Store } from '../../store/index.js'
import { readOptionalFile } from './loader.js'
import {
  instructionPath,
  type InstructionKind,
  type InstructionScope,
} from './paths.js'

/** 单个指令文件的注入预算（token）；超限保头截断并显式标注。 */
export const INSTRUCTION_FILE_TOKEN_BUDGET = 4000

/** 召回 token 估算：CJK≈1 token/字，其余约 4 字符 1 token（与 agent-core 口径一致）。 */
export function estimateTextTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? [])
    .length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 按 token 预算保头截断；先按比例收缩再逐步收敛。 */
export function clipToTokenBudget(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (estimateTextTokens(text) <= budget) return { text, truncated: false }
  const ratio = budget / estimateTextTokens(text)
  let end = Math.max(0, Math.floor(text.length * ratio))
  let piece = text.slice(0, end)
  while (end > 0 && estimateTextTokens(piece) > budget) {
    end = Math.max(0, end - 64)
    piece = text.slice(0, end)
  }
  return { text: piece.trimEnd(), truncated: true }
}

const LAYERS: {
  scope: InstructionScope
  kind: InstructionKind
  label: string
}[] = [
  { scope: 'global', kind: 'agents', label: '全局指令（AGENTS.md）' },
  {
    scope: 'project',
    kind: 'agents',
    label: '项目指令（AGENTS.md；与全局指令冲突时以本段为准）',
  },
  { scope: 'global', kind: 'memory', label: '全局记忆（MEMORY.md）' },
  { scope: 'project', kind: 'memory', label: '项目记忆（MEMORY.md）' },
]

/**
 * 构建注入 system prompt 的指令/记忆块：全局 AGENTS → 项目 AGENTS →
 * 全局 MEMORY → 项目 MEMORY。文件缺失/读失败静默跳过；空块返回空串
 * （调用方按「没有这层上下文」处理）。
 */
export async function buildInstructionBlock(
  store: Store,
  sessionId: string,
): Promise<string> {
  const session = store.sessions.get(sessionId)
  const projectId = session?.projectId ?? null
  const sections: string[] = []
  for (const layer of LAYERS) {
    const path = instructionPath(store, layer.scope, layer.kind, projectId)
    const raw = await readOptionalFile(path)
    if (raw.trim() === '') continue
    const clipped = clipToTokenBudget(raw.trim(), INSTRUCTION_FILE_TOKEN_BUDGET)
    sections.push(
      `=== ${layer.label} ===\n${clipped.text}${
        clipped.truncated ? '\n⚠️ 内容过长，已截断。' : ''
      }`,
    )
  }
  if (sections.length === 0) return ''
  return `[指令与记忆文件 · 自动注入]\n${sections.join('\n\n')}`
}
