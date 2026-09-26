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
    '一次回复最多经历多少轮模型调用；超限如实失败，不假装完成。',
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
    'Provider 请求建立阶段失败自动重试次数；0 表示不重试。',
  ],
  [
    'requestTimeoutSec',
    '请求超时（秒）',
    '120（默认）',
    '单次 Provider 请求超时；流式输出期间也受此约束。',
  ],
  [
    'maxRunTimeoutSec',
    'Run 总时长上限（秒）',
    '7200（默认，2 小时）',
    '一次回复的总时长上限；到点以 run_timeout 失败。',
  ],
  [
    'maxRunTotalTokens',
    'Run token 总预算',
    '200000000（默认，2 亿）',
    '各模型轮累计输入与输出 token 上限。',
  ],
  [
    'maxToolCalls',
    '工具调用次数上限',
    '1000（默认）',
    '一次回复最多执行多少次工具调用。',
  ],
  [
    'maxContinuationTurns',
    '续写轮次上限',
    '2（默认）',
    '输出被截断时自动续写的最大连续轮次。',
  ],
  [
    'maxDepth',
    '最大委派深度',
    '1（默认）',
    '顶层 Run 为 0；设为 1 时子 Agent 不可继续委派。',
  ],
  [
    'maxChildRuns',
    '每个 Run 的子 Agent 总数',
    '4（默认）',
    '限制单个父 Run 生命周期内创建的子 Agent 数量。',
  ],
  [
    'maxParallelChildren',
    '并行子 Agent 数',
    '2（默认）',
    '模型并行发起 task 时允许同时运行的子 Agent 数量。',
  ],
  [
    'maxChildTimeoutSec',
    '单个子 Agent 超时（秒）',
    '120（默认）',
    '到点后以 child_timeout 失败并停止该子 Run。',
  ],
  [
    'maxChildTotalTokens',
    '单个子 Agent 输出预算',
    '12000（默认）',
    '按 Provider usage 的累计输出 token 强制限制。',
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
