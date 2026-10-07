/** 将原文读取窗口转为逻辑行；末尾分隔符不是额外一行，实际空行必须保留。 */
export function splitReadLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) lines.pop()
  return lines
}
