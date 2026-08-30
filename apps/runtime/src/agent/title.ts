const TITLE_MAX_LENGTH = 24

/** 用首条用户消息派生会话标题；无有效内容时返回 null（保留默认标题）。 */
export function deriveSessionTitle(content: string): string | null {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return null
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, TITLE_MAX_LENGTH)}…`
}
