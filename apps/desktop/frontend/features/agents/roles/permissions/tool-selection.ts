/** Presentation groups only: Runtime remains responsible for inherited permissions. */
export const ROLE_TOOL_GROUPS = [
  {
    id: 'read',
    title: '文件读取',
    tools: [
      ['file.read', '读取文件'],
      ['file.list', '列出目录'],
      ['file.glob', '查找文件'],
      ['file.grep', '搜索内容'],
    ],
  },
  {
    id: 'edit',
    title: '文件修改',
    tools: [
      ['file.write', '写入文件'],
      ['file.write_stream', '分块写入'],
      ['file.edit', '编辑文件'],
      ['file.mkdir', '创建目录'],
      ['file.move', '移动文件'],
      ['file.delete', '删除文件'],
    ],
  },
  {
    id: 'web',
    title: '网页访问',
    tools: [
      ['web.fetch', '抓取网页'],
      ['browser.navigate', '打开网页'],
      ['browser.read', '读取网页'],
      ['browser.close', '关闭网页'],
    ],
  },
  {
    id: 'browser-interaction',
    title: '网页交互',
    tools: [
      ['browser.click', '点击网页控件'],
      ['browser.type', '填写网页文本'],
      ['browser.execute', '通用动作与受控脚本'],
    ],
  },
  { id: 'shell', title: '命令执行', tools: [['shell.execute', '执行命令']] },
  {
    id: 'assist',
    title: '辅助能力',
    tools: [
      ['get_current_time', '获取时间'],
      ['skill.use', '加载技能'],
      ['ask_user', '向用户提问'],
    ],
  },
] as const

export const ROLE_BUILTIN_TOOLS: string[] = ROLE_TOOL_GROUPS.flatMap((group) =>
  group.tools.map(([id]) => id),
)
const research = ROLE_TOOL_GROUPS.filter((group) =>
  ['read', 'web', 'assist'].includes(group.id),
).flatMap((group) => group.tools.map(([id]) => id))
export const ROLE_TOOL_PRESETS = [
  { label: '读取与研究', tools: research },
  {
    label: '文件编辑',
    tools: [
      ...research,
      'file.write',
      'file.write_stream',
      'file.edit',
      'file.mkdir',
    ],
  },
  {
    label: '开发执行',
    tools: [
      ...research,
      'file.write',
      'file.write_stream',
      'file.edit',
      'file.mkdir',
      'shell.execute',
    ],
  },
]

/** Preserve unrelated tools (including MCP and delegation) when changing a group. */
export function setToolGroup(
  current: string[],
  group: readonly string[],
  enabled: boolean,
): string[] {
  return enabled
    ? [...new Set([...current, ...group])]
    : current.filter((tool) => !group.includes(tool))
}

export function applyToolPreset(current: string[], tools: string[]): string[] {
  return [
    ...new Set([
      ...current.filter((tool) => !ROLE_BUILTIN_TOOLS.includes(tool)),
      ...tools,
    ]),
  ]
}
