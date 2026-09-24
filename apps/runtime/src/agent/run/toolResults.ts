import { JsonValueSchema, type JsonValue } from '@reflexion-os-studio/contracts'

/**
 * 回填模型的工具结果上限：file.read（默认 2000 行）、shell.execute（256KB）
 * 等真实工具结果远超一次模型调用的合理载荷，超过即截断并保留原文长度提示，
 * 防止 Context 预算在单次 Run 内被单条结果击穿。
 * 持久化仍保存完整结果（审计需要），截断只作用于回填与历史重建。
 *
 * 截断策略分两条路径：
 * - JSON 结果（Rust 工具的返回均为 JSON）：只收缩超长字符串与大数组字段，
 *   保留头尾、省略中间；元数据字段（totalLines/truncated/exitCode 等）原样
 *   保留——serde_json 键按字母序输出，content/matches 排在元数据之前，朴素
 *   尾部截断会把分页与截断语义一起切掉。
 * - 纯文本结果：保留头尾、省略中间，并注明原文总长。
 */
export const MODEL_TOOL_RESULT_MAX_CHARS = 16_000

/** 纯文本截断的首尾保留量（含省略标记总量恒低于上限）。 */
const PLAIN_HEAD_CHARS = 10_000
const PLAIN_TAIL_CHARS = 3_000

/** JSON 内超长字符串的首轮收缩参数；放不下时逐轮减半直到下限。 */
const STRING_HEAD = 3_000
const STRING_TAIL = 1_500
/** JSON 内大数组的首轮收缩参数（头尾各保留条数）。 */
const ARRAY_HEAD = 40
const ARRAY_TAIL = 20
/** 收缩下限：全部触底仍未放得下则放弃结构化路径，退回纯文本截断。 */
const STRING_FLOOR_HEAD = 600
const STRING_FLOOR_TAIL = 300
const ARRAY_FLOOR_HEAD = 4
const ARRAY_FLOOR_TAIL = 2
const MAX_SHRINK_STEPS = 5

/** 文本截断：不超过上限原样返回；超过则保留头尾、省略中间。 */
export function capToolResultForModel(content: string): string {
  if (content.length <= MODEL_TOOL_RESULT_MAX_CHARS) return content
  const parsed = tryParseJsonValue(content)
  if (parsed !== undefined) {
    let stringHead = STRING_HEAD
    let stringTail = STRING_TAIL
    let arrayHead = ARRAY_HEAD
    let arrayTail = ARRAY_TAIL
    for (let step = 0; step <= MAX_SHRINK_STEPS; step += 1) {
      const serialized = JSON.stringify(
        capJsonValue(parsed, { stringHead, stringTail, arrayHead, arrayTail }),
      )
      if (serialized.length <= MODEL_TOOL_RESULT_MAX_CHARS) {
        return serialized
      }
      stringHead = Math.max(STRING_FLOOR_HEAD, Math.floor(stringHead / 2))
      stringTail = Math.max(STRING_FLOOR_TAIL, Math.floor(stringTail / 2))
      arrayHead = Math.max(ARRAY_FLOOR_HEAD, Math.floor(arrayHead / 2))
      arrayTail = Math.max(ARRAY_FLOOR_TAIL, Math.floor(arrayTail / 2))
    }
  }
  return capPlainText(content)
}

interface ShrinkParams {
  stringHead: number
  stringTail: number
  arrayHead: number
  arrayTail: number
}

/** 结构化收缩：字符串按头尾截断；数组作为对象字段时截头去尾并记省略数。 */
function capJsonValue(value: JsonValue, params: ShrinkParams): JsonValue {
  if (typeof value === 'string') {
    return capString(value, params)
  }
  if (Array.isArray(value)) {
    return value.map((item) => capJsonValue(item, params))
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (Array.isArray(entry)) {
        result[key] = capArrayField(key, entry, params, result)
        continue
      }
      result[key] = capJsonValue(entry, params)
    }
    return result
  }
  return value
}

function capArrayField(
  key: string,
  entries: JsonValue[],
  params: ShrinkParams,
  target: Record<string, JsonValue>,
): JsonValue {
  const { arrayHead, arrayTail } = params
  if (entries.length <= arrayHead + arrayTail) {
    return entries.map((item) => capJsonValue(item, params))
  }
  const omitted = entries.length - arrayHead - arrayTail
  target[`${key}Elided`] = omitted
  return [
    ...entries.slice(0, arrayHead).map((item) => capJsonValue(item, params)),
    ...entries
      .slice(entries.length - arrayTail)
      .map((item) => capJsonValue(item, params)),
  ]
}

function capString(value: string, params: ShrinkParams): string {
  const { stringHead, stringTail } = params
  if (value.length <= stringHead + stringTail) return value
  const omitted = value.length - stringHead - stringTail
  return `${value.slice(0, stringHead)}…（中间省略 ${omitted} 字符）…${value.slice(value.length - stringTail)}`
}

/** 纯文本截断：保留头尾、省略中间（Codex 风格），提示原文总长。 */
function capPlainText(content: string): string {
  const omitted = content.length - PLAIN_HEAD_CHARS - PLAIN_TAIL_CHARS
  return `${content.slice(0, PLAIN_HEAD_CHARS)}\n\n…（中间省略 ${omitted} 字符，原文共 ${content.length} 字符）…\n\n${content.slice(content.length - PLAIN_TAIL_CHARS)}`
}

function tryParseJsonValue(content: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(content)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

/** 工具结果落库：能解析为 JSON 则存结构，否则存原文。 */
export function parseToolResultPayload(content: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(content)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : content
  } catch {
    return content
  }
}
