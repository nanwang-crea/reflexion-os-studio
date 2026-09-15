import { z } from 'zod'
import { lookupCommandSchema } from './commands.js'

/**
 * 从 zod 契约派生字段级范围/格式提示（中文文案），供表单 hint 使用。
 *
 * 契约是唯一真源：所有边界值来自 `z.toJSONSchema()` 输出，UI 不重复手写
 * `1–64`、`>=10` 这类常量，避免契约与前端漂移。取不到就返回 undefined。
 */

/** 列出某命令 params 里带范围约束的字段 → 提示文本，供表单一次性生成占位说明。 */
export function contractRangeHints(
  method: string,
  fieldPaths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of fieldPaths) {
    const hint = contractRangeHint(method, path)
    if (hint) out[path] = hint
  }
  return out
}

/**
 * 查询某命令 params 中某字段路径的契约取值范围，生成如
 * `应为 1–64 的整数` 的提示文本（支持 `settings.maxTurns`、`models[0]`）。
 */
export function contractRangeHint(
  method: string,
  fieldPath: string,
): string | undefined {
  const node = resolveSchemaNode(schemaFor(method), fieldPath)
  return boundsHintFromJsonSchema(node)
}

function schemaFor(method: string): unknown {
  const entry = lookupCommandSchema(method)
  if (!entry) return undefined
  try {
    return z.toJSONSchema(entry.params, { io: 'input' })
  } catch {
    return z.toJSONSchema(entry.params)
  }
}

const SEGMENT_PATTERN = /[^.[\]]+|\[(\d+)\]/g

/** 按点/下标路径在 JSON Schema 的 properties / items 里逐层下钻。 */
function resolveSchemaNode(root: unknown, fieldPath: string): unknown {
  let current: unknown = root
  for (const match of fieldPath.matchAll(SEGMENT_PATTERN)) {
    if (!current || typeof current !== 'object') return undefined
    const record = current as Record<string, unknown>
    if (match[1] !== undefined) {
      const items = record.items
      current = Array.isArray(items) ? items[Number(match[1])] : items
      continue
    }
    const children = record.properties
    current =
      children && typeof children === 'object'
        ? (children as Record<string, unknown>)[match[0]]
        : record.additionalProperties
  }
  return current
}

/**
 * 从 JSON Schema 节点（可能包 anyOf / type 数组）提取边界并生成提示。
 */
function boundsHintFromJsonSchema(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  for (const key of ['anyOf', 'oneOf']) {
    const branches = record[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const nested = boundsHintFromJsonSchema(branch)
        if (nested) return nested
      }
      return undefined
    }
  }
  const typeValue = record.type
  const types = (Array.isArray(typeValue) ? typeValue : [typeValue]).filter(
    (item): item is string => typeof item === 'string' && item !== 'null',
  )
  const kind = types.find((item) =>
    ['number', 'integer', 'string'].includes(item),
  )
  if (!kind) return undefined
  if (kind === 'string') {
    if (record.format === 'url' || record.format === 'uri') {
      return '需是带协议的完整 URL，如 https://api.example.com/v1'
    }
    const minLength = record.minLength
    return typeof minLength === 'number' && minLength > 0
      ? '不能为空'
      : undefined
  }
  const isInt = kind === 'integer'
  // safeint 上限不是业务约束，是"能安全传给 JSON 的极限"；显示出来误导。
  const safeIntCeiling = Number.MAX_SAFE_INTEGER
  const rawMin = numberOrUndefined(record.minimum)
  const rawMax = numberOrUndefined(record.maximum)
  const exclMin = numberOrUndefined(record.exclusiveMinimum)
  const exclMax = numberOrUndefined(record.exclusiveMaximum)
  const minimum =
    rawMin !== undefined
      ? rawMin
      : exclMin !== undefined
        ? isInt
          ? exclMin + 1
          : exclMin
        : undefined
  const minimumInclusive = rawMin !== undefined || isInt
  const maximum =
    rawMax !== undefined && rawMax !== safeIntCeiling
      ? rawMax
      : exclMax !== undefined && exclMax !== safeIntCeiling
        ? isInt
          ? exclMax - 1
          : exclMax
        : undefined
  const kindText = isInt ? '整数' : '数字'
  if (minimum !== undefined && maximum !== undefined) {
    return `应为 ${minimum}–${maximum} 的${kindText}`
  }
  if (minimum !== undefined) {
    return `应为 ${minimumInclusive ? '≥' : '>'}${minimum} 的${kindText}`
  }
  if (maximum !== undefined) return `应为 ≤${maximum} 的${kindText}`
  return `应为${kindText}`
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
