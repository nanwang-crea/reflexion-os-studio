import type { AgentSettings } from '@reflexion-os-studio/runtime-client'

export interface AgentRuntimeField {
  key: keyof AgentSettings
  path: string
  label: string
  placeholder: string
  description: string
}

export const AGENT_RUNTIME_FIELDS: AgentRuntimeField[] = [
  [
    'maxTurns',
    '最大轮次（模型调用上限）',
    '100（默认）',
    '控制一次运行的模型调用次数；手动停止和重复无进展检测仍生效。',
  ],
  [
    'reflectionThreshold',
    '反思阈值（失败次数）',
    '2（默认）',
    '工具失败累计达到该次数后自动注入反思消息；0 表示禁用反思。',
  ],
  [
    'requestRetries',
    '请求重试次数',
    '5（默认）',
    'Provider 请求建立阶段失败自动重试次数；0 表示不重试。保留有限重试，避免请求失败后无限重试。',
  ],
  [
    'requestTimeoutSec',
    '请求超时（秒）',
    '120（默认）',
    '等待响应头或流数据的空闲超时；持续输出会刷新计时。为识别断线，保留 10–600 秒，不提供“不限制”。',
  ],
  [
    'maxRunTimeoutSec',
    'Run 总时长上限（秒）',
    '7200（默认，2 小时）',
    '控制一次运行的总耗时，包含模型和工具执行；不限制时不因总时长停止。',
  ],
  [
    'maxRunTotalTokens',
    'Run token 总预算',
    '200000000（默认，2 亿）',
    '统计本次运行各轮累计输入与输出 token，独立于模型的单次输出上限。',
  ],
  [
    'maxToolCalls',
    '工具调用次数上限',
    '1000（默认）',
    '统计本次运行累计工具调用次数，独立于权限审批。',
  ],
  [
    'maxContinuationTurns',
    '续写轮次上限',
    '2（默认）',
    '控制输出被截断后的连续自动续写次数；自定义 0 关闭自动续写。',
  ],
  [
    'maxDepth',
    '最大委派深度',
    '1（默认）',
    '顶层 Run 为 0；最大可设为 4，设为 1 时子 Agent 不可继续委派。',
  ],
  [
    'maxChildRuns',
    '整棵委派树的活跃子 Agent 上限',
    '4（默认）',
    '仅未结束的子 Agent 占用名额，完成、失败或取消后释放；“不限制”不解除并发数和委派深度上限。',
  ],
  [
    'maxParallelChildren',
    '并行子 Agent 数',
    '2（默认）',
    '限制整棵树同时运行的子 Agent 数量；保留 1–8 个的资源边界，不提供“不限制”。',
  ],
  [
    'maxChildTimeoutSec',
    '单个子 Agent 超时（秒）',
    '不单独限时（仍随父任务停止）',
    '默认或“不限制”均不设置独立超时；自定义后到点停止，父任务停止或取消仍会结束子任务。',
  ],
  [
    'maxChildTotalTokens',
    '单个子 Agent 输出预算',
    '12000（默认）',
    '按 Provider usage 统计累计输出 token；“不限制”取消此预算，父任务的预算仍生效。',
  ],
].map(([key, label, placeholder, description]) => ({
  key: key as keyof AgentSettings,
  path: `settings.${key}`,
  label,
  placeholder,
  description,
}))

export const AGENT_RUNTIME_GROUPS: {
  id: string
  title: string
  keys: (keyof AgentSettings)[]
}[] = [
  {
    id: 'loop',
    title: '循环',
    keys: [
      'maxTurns',
      'reflectionThreshold',
      'maxRunTimeoutSec',
      'maxRunTotalTokens',
      'maxToolCalls',
      'maxContinuationTurns',
    ],
  },
  {
    id: 'network',
    title: '网络',
    keys: ['requestRetries', 'requestTimeoutSec'],
  },
  {
    id: 'delegation',
    title: '子 Agent 委派',
    keys: [
      'maxDepth',
      'maxChildRuns',
      'maxParallelChildren',
      'maxChildTimeoutSec',
      'maxChildTotalTokens',
    ],
  },
]

export const AGENT_RUNTIME_FIELD_BY_KEY = new Map(
  AGENT_RUNTIME_FIELDS.map((field) => [field.key, field]),
)
