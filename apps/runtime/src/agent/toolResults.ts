/**
 * 回填模型的工具结果上限：file.read（默认 2000 行）、shell.execute（256KB）
 * 等真实工具结果远超一次模型调用的合理载荷，超过即截断并保留原文长度提示，
 * 防止 Context 预算在单次 Run 内被单条结果击穿。
 * 持久化仍保存完整结果（审计需要），截断只作用于回填与历史重建。
 */
export const MODEL_TOOL_RESULT_MAX_CHARS = 16_000

/** 文本截断：不超过上限原样返回；超过则截断并附"原文共 N 字符"提示。 */
export function capToolResultForModel(content: string): string {
  if (content.length <= MODEL_TOOL_RESULT_MAX_CHARS) return content
  return `${content.slice(0, MODEL_TOOL_RESULT_MAX_CHARS)}\n\n…（结果过长已截断，原文共 ${content.length} 字符）`
}
