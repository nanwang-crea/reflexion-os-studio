import {
  ContextCheckpointSummarySchema,
  type ContextCheckpointSummary,
} from '@reflexion-os-studio/contracts'

/** 简易 secret 过滤：命中即整行丢弃（摘要不应承载凭据）。 */
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|api[_-]?key\s*[:=]|authorization\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}|cookie\s*[:=]|token\s*[:=]\s*[A-Za-z0-9._-]{12,})/i

export function filterSecretLine(line: string): string | null {
  if (SECRET_PATTERN.test(line)) return null
  return line.trim() === '' ? null : line
}

export function sanitizeSummary(raw: unknown): ContextCheckpointSummary {
  const parsed = ContextCheckpointSummarySchema.safeParse(raw)
  if (!parsed.success) throw new Error('checkpoint summary: invalid schema')
  const data = parsed.data
  const clean = (lines: string[]): string[] =>
    lines.map(filterSecretLine).filter((line): line is string => line !== null)
  const summary = {
    goal: data.goal === null ? null : (filterSecretLine(data.goal) ?? null),
    constraints: clean(data.constraints),
    decisions: clean(data.decisions),
    completed: clean(data.completed),
    pending: clean(data.pending),
    toolFacts: clean(data.toolFacts),
    knownErrors: clean(data.knownErrors),
  }
  if (!checkpointSummaryHasContent(summary))
    throw new Error('checkpoint summary: empty result')
  return summary
}

/** Checkpoint 摘要是否有可用内容（全空则退回全文摘要路径）。 */
export function checkpointSummaryHasContent(
  summary: ContextCheckpointSummary,
): boolean {
  return (
    summary.goal !== null ||
    summary.completed.length > 0 ||
    summary.pending.length > 0 ||
    summary.decisions.length > 0 ||
    summary.toolFacts.length > 0 ||
    summary.constraints.length > 0 ||
    summary.knownErrors.length > 0
  )
}
