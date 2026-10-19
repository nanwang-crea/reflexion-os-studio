import type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'

/** Checkpoint 注入块：稳定顺序的结构化上下文（§6.4 第 3 项）。 */
export function formatCheckpointBlock(
  summary: ContextCheckpointSummary,
): string {
  const lines: string[] = ['[上下文摘要]']
  if (summary.goal !== null) lines.push(`目标：${summary.goal}`)
  if (summary.constraints.length > 0)
    lines.push(`约束：\n${summary.constraints.map((c) => `- ${c}`).join('\n')}`)
  if (summary.decisions.length > 0)
    lines.push(`已定：\n${summary.decisions.map((c) => `- ${c}`).join('\n')}`)
  if (summary.completed.length > 0)
    lines.push(`已完成：\n${summary.completed.map((c) => `- ${c}`).join('\n')}`)
  if (summary.pending.length > 0)
    lines.push(`待办：\n${summary.pending.map((c) => `- ${c}`).join('\n')}`)
  if (summary.toolFacts.length > 0)
    lines.push(
      `工具事实：\n${summary.toolFacts.map((c) => `- ${c}`).join('\n')}`,
    )
  if (summary.knownErrors.length > 0)
    lines.push(
      `已知错误：\n${summary.knownErrors.map((c) => `- ${c}`).join('\n')}`,
    )
  return lines.join('\n')
}
