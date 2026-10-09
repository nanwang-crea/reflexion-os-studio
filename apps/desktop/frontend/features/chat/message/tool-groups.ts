import type { ToolCall } from '@reflexion-os-studio/runtime-client'

type GroupKind =
  | 'read'
  | 'edit'
  | 'command'
  | 'web'
  | 'directory'
  | 'skill'
  | 'time'
  | 'single'
export interface ToolGroup {
  kind: GroupKind
  calls: ToolCall[]
}

const READ_TOOLS = new Set(['file.read', 'file.list', 'file.glob', 'file.grep'])
const EDIT_TOOLS = new Set(['file.edit', 'file.write', 'file.write_stream'])

function kindOf(call: ToolCall): GroupKind {
  if (call.status !== 'completed' || call.errorCode !== null) return 'single'
  if (READ_TOOLS.has(call.toolName)) return 'read'
  if (EDIT_TOOLS.has(call.toolName)) return 'edit'
  if (call.toolName === 'shell.execute') return 'command'
  if (call.toolName === 'web.fetch') return 'web'
  if (call.toolName === 'file.mkdir') return 'directory'
  if (call.toolName === 'skill.use') return 'skill'
  if (call.toolName === 'get_current_time') return 'time'
  return 'single'
}

export function groupToolCalls(calls: ToolCall[]): ToolGroup[] {
  const groups: ToolGroup[] = []
  for (const call of calls) {
    const kind = kindOf(call)
    const previous = groups.at(-1)
    if (kind !== 'single' && previous?.kind === kind) previous.calls.push(call)
    else groups.push({ kind, calls: [call] })
  }
  return groups.map((group) =>
    group.calls.length === 1 && group.kind !== 'time'
      ? { ...group, kind: 'single' }
      : group,
  )
}

function filePath(call: ToolCall): string | undefined {
  const args = call.args
  return args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    typeof args.path === 'string'
    ? args.path
    : undefined
}

export function describeToolGroup(group: ToolGroup): string {
  const count = group.calls.length
  switch (group.kind) {
    case 'command':
      return `执行了 ${count} 条命令`
    case 'web':
      return `抓取了 ${count} 次网页`
    case 'directory':
      return `完成了 ${count} 次目录创建`
    case 'skill':
      return `加载了 ${count} 次技能`
    case 'time':
      return '辅助操作'
  }
  if (group.kind === 'edit') {
    const paths = new Set(group.calls.map(filePath).filter(Boolean))
    if (paths.size === 1)
      return `已修改 ${[...paths][0]} · ${group.calls.length} 次操作`
    return paths.size > 0
      ? `已修改 ${paths.size} 个文件 · ${group.calls.length} 次操作`
      : `已完成 ${group.calls.length} 次文件修改`
  }
  const reads = group.calls.filter((call) => call.toolName === 'file.read')
  const paths = new Set(reads.map(filePath).filter(Boolean))
  const searches = group.calls.filter(
    (call) => call.toolName === 'file.glob' || call.toolName === 'file.grep',
  ).length
  const directories = group.calls.filter(
    (call) => call.toolName === 'file.list',
  ).length
  return [
    reads.length > 0 ? `查看了 ${paths.size || reads.length} 个文件` : '',
    searches > 0 ? `搜索了 ${searches} 次` : '',
    directories > 0 ? `列出了 ${directories} 次目录` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
