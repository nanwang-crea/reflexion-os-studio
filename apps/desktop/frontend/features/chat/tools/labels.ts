import type { ToolCall } from '@reflexion-os-studio/runtime-client'

const TOOL_LABELS: Record<string, string> = {
  'file.read': '读取文件',
  'file.list': '列出目录',
  'file.glob': '查找文件',
  'file.grep': '搜索内容',
  'file.write': '写入文件',
  'file.write_stream': '分块写入文件',
  'file.edit': '编辑文件',
  'file.delete': '删除文件',
  'file.move': '移动文件',
  'file.mkdir': '创建目录',
  'shell.execute': '执行命令',
  'web.fetch': '读取已知网页',
  'browser.navigate': '打开网页',
  'browser.read': '读取网页',
  'browser.close': '关闭网页',
  'skill.use': '加载技能',
  get_current_time: '获取时间',
}

/** A known search URL changes presentation only, never tool authorization. */
export function toolLabel(call: Pick<ToolCall, 'toolName' | 'args'>): string {
  if (
    call.toolName === 'browser.navigate' &&
    call.args &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    typeof call.args.url === 'string'
  ) {
    try {
      const url = new URL(call.args.url)
      if (
        url.protocol === 'https:' &&
        ['www.google.com', 'google.com', 'www.bing.com', 'bing.com'].includes(
          url.hostname,
        ) &&
        url.pathname === '/search' &&
        url.searchParams.has('q')
      )
        return '搜索网页'
    } catch {
      /* Invalid arguments remain for the tool to validate. */
    }
  }
  return TOOL_LABELS[call.toolName] ?? call.toolName
}
