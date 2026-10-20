import type { ToolCall } from '@reflexion-os-studio/runtime-client'

/** 摘要只投影已提供的参数；完整参数仍由工具详情展示。 */
export function summarizeToolArgs({
  args,
  toolName,
}: Pick<ToolCall, 'args' | 'toolName'>): string {
  if (args === null) return ''
  if (Array.isArray(args)) return `${args.length} 项输入`
  if (typeof args !== 'object') return compact(String(args))
  const text = (key: string): string =>
    typeof args[key] === 'string' ? args[key] : ''
  if (toolName === 'file.grep') {
    return compact(
      [text('pattern') || text('text'), text('glob') || text('path')]
        .filter(Boolean)
        .join(' · '),
    )
  }
  if (toolName === 'file.glob')
    return compact([text('pattern'), text('path')].filter(Boolean).join(' · '))
  if (toolName === 'browser.execute')
    return args.mode === 'script'
      ? '动作脚本'
      : `动作计划 · ${Array.isArray(args.steps) ? args.steps.length : 0} 步`
  for (const key of ['path', 'command', 'url', 'query', 'skillId', 'name']) {
    if (text(key)) return compact(text(key))
  }
  const count = Object.keys(args).length
  return count > 0 ? `${count} 项参数 · 展开查看` : ''
}

function compact(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}
