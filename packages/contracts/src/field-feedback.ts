import { lookupCommandSchema } from './commands.js'

/** 一条校验反馈：字段路径 + 中文说明（不含任何用户输入值）。 */
export interface FieldFeedback {
  /** 字段路径（`settings.maxTurns`）；数组元素带下标（`models[1]`）。 */
  path: string
  /** 中文说明，可直接展示给用户。 */
  message: string
}

/** zod issue 的结构化子集：只取路径与边界元数据，**绝不含用户输入的值**。 */
export interface ZodIssueLike {
  path: readonly PropertyKey[]
  code?: string
  message?: string
  minimum?: number | bigint
  maximum?: number | bigint
  inclusive?: boolean
  type?: string
  format?: string
  origin?: string
}

/**
 * 字段名 → 中文标签。只登记跨页复用的字段；未登记的退回字段名本身。
 * 注意：这些是**展示文案**，不是校验规则（规则始终来自 zod 契约）。
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  requestId: '请求标识',
  projectId: '项目',
  sessionId: '会话',
  runId: '运行',
  message: '消息',
  providerId: '模型服务',
  id: '标识',
  name: '名称',
  kind: '类型',
  baseUrl: 'Base URL',
  apiKey: 'API Key',
  secret: 'API Key',
  secretRef: 'API Key 引用',
  models: '模型列表',
  defaultModel: '默认模型',
  contextWindow: '上下文窗口',
  temperature: 'Temperature',
  maxTokens: '最大输出 Tokens',
  capabilities: '能力',
  enabled: '启用状态',
  settings: '运行参数',
  contextBudget: '上下文预算',
  contextTokenLimit: '上下文 Token 上限',
  maxTurns: '最大轮次',
  reflectionThreshold: '反思触发阈值',
  requestRetries: '请求重试次数',
  requestTimeoutSec: '请求超时（秒）',
  maxRunTimeoutSec: '单次运行上限（秒）',
  maxRunTotalTokens: '单次运行 Token 上限',
  maxToolCalls: '单次运行工具调用上限',
  maxContinuationTurns: '续写轮次上限',
  maxDepth: '子 Agent 嵌套层数上限',
  maxChildRuns: '子 Agent 总数上限',
  maxParallelChildren: '子 Agent 并发上限',
  maxChildTimeoutSec: '子 Agent 超时（秒）',
  maxChildTotalTokens: '子 Agent 输出预算',
  command: '启动命令',
  args: '参数',
  env: '环境变量',
  folderPath: '文件夹路径',
  rows: '行数',
  cols: '列数',
})

function toPathString(path: readonly PropertyKey[]): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${String(seg)}` : String(seg)
  }
  return out || '(root)'
}

/**
 * 范围的中文描述，如 `应为 1–64 的整数`。无边界信息时 undefined。
 * safeint 上限（Number.MAX_SAFE_INTEGER）不是业务约束，不显示具体数字，
 * 避免"应为 ≤9007199254740991 的整数"这类无意义提示。
 */
function describeBounds(issue: ZodIssueLike): string | undefined {
  const isInt = issue.origin === 'int' || issue.type === 'int'
  const kind = isInt ? '整数' : '数字'
  const safeCeiling = BigInt(Number.MAX_SAFE_INTEGER)
  const rawMin = normalizeBound(issue.minimum)
  const rawMax = normalizeBound(issue.maximum)
  const minimum = rawMin === safeCeiling ? undefined : rawMin
  const maximum = rawMax === safeCeiling ? undefined : rawMax
  if (minimum !== undefined && maximum !== undefined) {
    const lo = issue.inclusive === false ? `>${minimum}` : `≥${minimum}`
    const hi = issue.inclusive === false ? `<${maximum}` : `≤${maximum}`
    return `应为 ${lo} 且 ${hi} 的${kind}`
  }
  if (minimum !== undefined) {
    return `应为 ${issue.inclusive === false ? '>' : '≥'}${minimum} 的${kind}`
  }
  if (maximum !== undefined) {
    return `应为 ${issue.inclusive === false ? '<' : '≤'}${maximum} 的${kind}`
  }
  if (rawMax === safeCeiling || rawMin === safeCeiling) {
    return `不是安全的${kind}`
  }
  return undefined
}

/** bigint/number → 十进制字符串；safeint 上限视为"无业务边界"返回 undefined。 */
function describeNumericBound(
  value: number | bigint | undefined,
): string | undefined {
  const normalized = normalizeBound(value)
  if (normalized === undefined) return undefined
  if (normalized === BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return normalized.toString()
}

/** bigint/number → bigint 归一；模板字面量对 bigint 会追加 `n`，避免直接嵌入。 */
function normalizeBound(
  value: number | bigint | undefined,
): bigint | undefined {
  if (value === undefined) return undefined
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
}

/** 从 zod 英文消息提取 "expected X, received Y" 并本地化（只有类型名，安全）。 */
function expectedTypeText(message?: string): string | undefined {
  const match = /expected (.+?), received (.+)$/i.exec(message ?? '')
  if (!match) return undefined
  const expected = translateTypeName(match[1] ?? '')
  const received = translateTypeName(match[2] ?? '')
  return received === '空'
    ? `${expected}必填`
    : `应为${expected}，收到${received}`
}

const TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  number: '数字',
  int: '整数',
  string: '文本',
  boolean: '是/否值',
  array: '数组',
  object: '对象',
  'string[]': '文本数组',
  undefined: '空',
  null: '空',
  'undefined | null': '空',
  nan: '非数字',
})

function translateTypeName(raw: string): string {
  return TYPE_LABELS[raw] ?? raw
}

/**
 * 单个 zod issue → 中文说明。覆盖设置页与表单真实会撞到的错误码；
 * 未识别的退回 zod 自己的 message（英文，但不含输入值）。
 */
export function describeZodIssue(
  issue: ZodIssueLike,
  labels?: Record<string, string>,
): FieldFeedback {
  const merged = labels ? { ...FIELD_LABELS, ...labels } : FIELD_LABELS
  const path = toPathString(issue.path)
  const label = labelForPath(issue.path, merged)
  const bounds = describeBounds(issue)

  switch (issue.code) {
    case 'invalid_key':
      return { path, message: `${label}不是可设置的项` }
    case 'too_small':
      if (issue.origin === 'number' || issue.origin === 'int') {
        const min = describeNumericBound(issue.minimum)
        const op = issue.inclusive === false ? '>' : '≥'
        return {
          path,
          message: `${label}过小${min !== undefined ? `（应 ${op}${min}）` : ''}`,
        }
      }
      if (issue.origin === 'string') {
        return { path, message: `${label}不能为空` }
      }
      if (issue.origin === 'array') {
        return { path, message: `${label}至少需要 1 项` }
      }
      return {
        path,
        message: `${label}取值过小${bounds ? `（${bounds}）` : ''}`,
      }
    case 'too_big':
      if (issue.origin === 'number' || issue.origin === 'int') {
        const max = describeNumericBound(issue.maximum)
        const op = issue.inclusive === false ? '<' : '≤'
        return {
          path,
          message: `${label}过大${max !== undefined ? `（应 ${op}${max}）` : '（超出安全整数范围）'}`,
        }
      }
      if (issue.origin === 'string') {
        return { path, message: `${label}过长` }
      }
      if (issue.origin === 'array') {
        return { path, message: `${label}条目过多` }
      }
      return {
        path,
        message: `${label}取值过大${bounds ? `（${bounds}）` : ''}`,
      }
    case 'invalid_type':
      if (issue.format === 'safeint') {
        return { path, message: `${label}必须是整数` }
      }
      if (expectedTypeText(issue.message)) {
        return {
          path,
          message: `${label}格式不对：${expectedTypeText(issue.message)}`,
        }
      }
      return { path, message: `${label}格式不对` }
    case 'not_multiple_of':
      return { path, message: `${label}必须是整数` }
    case 'invalid_format':
      return {
        path,
        message:
          issue.format === 'url' || issue.format === 'uri'
            ? `${label}需是带协议的完整 URL，如 https://api.example.com/v1`
            : `${label}格式不正确`,
      }
    case 'unrecognized_keys':
      return { path, message: '请求包含契约未定义的字段' }
    default:
      return {
        path,
        message: `${label}不符合要求${issue.message ? `：${issue.message}` : ''}`,
      }
  }
}

/**
 * 路径末段若是数组下标（number），退回父级字段名 + "第 N 项"；
 * 否则按 FIELD_LABELS 查。`models[1]` → "模型列表第 2 项"，
 * `settings.maxTurns` → "最大轮次"。
 */
function labelForPath(
  path: readonly PropertyKey[],
  labels: Record<string, string>,
): string {
  if (path.length === 0) return '请求参数'
  const leaf = path[path.length - 1]
  if (typeof leaf === 'number') {
    const parentSeg = path[path.length - 2]
    const parentLabel =
      parentSeg === undefined
        ? '数组'
        : (labels[String(parentSeg)] ?? String(parentSeg))
    return `${parentLabel}第 ${leaf + 1} 项`
  }
  return labels[String(leaf)] ?? String(leaf)
}

/**
 * 校验某命令的 params；成功返回 null，失败返回中文反馈列表。
 * UI 保存前预检与 Runtime 请求校验都走本函数，规则不会两处漂移。
 */
export function validateCommandParams(
  method: string,
  params: unknown,
  labels?: Record<string, string>,
): FieldFeedback[] | null {
  const entry = lookupCommandSchema(method)
  if (!entry) return null
  const parsed = entry.params.safeParse(params ?? {})
  if (parsed.success) return null
  return parsed.error.issues.map((issue) =>
    describeZodIssue(issue as ZodIssueLike, labels),
  )
}

/** 反馈列表 → 一行可直接展示的文案（最多 3 条 + 剩余计数）。 */
export function formatFieldFeedbacks(feeds: readonly FieldFeedback[]): string {
  const head = feeds
    .slice(0, 3)
    .map((item) => `${item.path}：${item.message}`)
    .join('；')
  const rest = feeds.length - Math.min(3, feeds.length)
  return rest > 0 ? `${head}；另有 ${rest} 处不符合要求` : head
}

/**
 * 校验"必须带协议的绝对 URL"（baseUrl / url 类字段）。
 * 返回 null 表示通过，否则返回可直接显示的中文原因。
 *
 * 与契约 `z.url()` 同语义但独立实现：契约只要求绝对 URL，UI 预检同样接受
 * http/https（本地 provider 常用 http://127.0.0.1），不额外强推 https。
 * 空格必须先于 `new URL()` 检测，否则"sk-xx https://…"这种整行粘贴只会
 * 得到一句"需是带协议"，用户不知道真正问题是混入了 Key 或换行。
 */
export function checkAbsoluteUrl(value: string, label = '地址'): string | null {
  const trimmed = value.trim()
  if (!trimmed) return `${label}不能为空`
  if (/\s/.test(trimmed)) {
    return `${label}不能包含空格/换行（若整行粘贴了 Key 或其他文本，请只保留 URL）`
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return `${label}需是带协议的完整 URL，例如 https://api.example.com/v1`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${label}协议只支持 http 或 https（当前：${url.protocol.replace(':', '')}）`
  }
  if (!url.hostname) return `${label}缺少主机名`
  return null
}

/**
 * Runtime 侧：zod issues → `path: 中文说明` 字符串数组（JSON-RPC error.data）。
 * 不含入参值，可安全落到日志与响应。
 */
export function summarizeZodIssuesForLog(
  issues: readonly ZodIssueLike[],
): string[] {
  return issues.map((issue) => {
    const feedback = describeZodIssue(issue)
    return `${feedback.path}: ${feedback.message}`
  })
}
