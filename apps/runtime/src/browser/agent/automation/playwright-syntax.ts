import type { Node } from 'acorn'
import {
  BrowserTargetSchema,
  type BrowserTarget,
} from '@reflexion-os-studio/contracts'
type Ast = Node & Record<string, unknown>
const ast = (value: unknown) => value as Ast
const invalid = () => new Error('browser_script_invalid')
type Literal = (value: unknown) => unknown

function options(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw invalid()
  return value as Record<string, unknown>
}
export function readLocatorExpression(
  raw: unknown,
  literal: Literal,
): BrowserTarget {
  const node = ast(raw)
  if (node.type !== 'CallExpression')
    return BrowserTargetSchema.parse(literal(raw))
  const callee = ast(node.callee)
  const args = node.arguments as unknown[]
  if (
    node.optional ||
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    ast(callee.object).type !== 'Identifier' ||
    ast(callee.object).name !== 'page' ||
    ast(callee.property).name !== 'getByRole' ||
    args.length !== 2
  )
    throw invalid()
  const opts = options(literal(args[1]), ['name', 'exact'])
  if (opts.exact === false) throw invalid()
  return BrowserTargetSchema.parse({ role: literal(args[0]), name: opts.name })
}
/** Familiar Playwright syntax is translated to data; no capability objects exist. */
export function translatePlaywrightCall(
  raw: unknown,
  literal: Literal,
): unknown | undefined {
  const call = ast(raw)
  const callee = ast(call.callee)
  if (
    call.type !== 'CallExpression' ||
    call.optional ||
    callee.type !== 'MemberExpression' ||
    callee.computed
  )
    throw invalid()
  const receiver = ast(callee.object)
  const method = String(ast(callee.property).name)
  const args = call.arguments as unknown[]
  if (receiver.type === 'Identifier' && receiver.name === 'page') {
    if (
      method === 'goto' &&
      args.length === 1 &&
      typeof literal(args[0]) === 'string'
    )
      return { action: 'goto', url: literal(args[0]) }
    if (method === 'waitForTimeout' && args.length === 1)
      return { action: 'wait', milliseconds: literal(args[0]) }
    return undefined
  }
  if (
    receiver.type === 'MemberExpression' &&
    !receiver.computed &&
    ast(receiver.object).name === 'page' &&
    ast(receiver.property).name === 'mouse'
  ) {
    if (method !== 'wheel' || args.length !== 2) throw invalid()
    return {
      action: 'scroll',
      deltaX: literal(args[0]),
      deltaY: literal(args[1]),
    }
  }
  const target = readLocatorExpression(receiver, literal)
  if (['click', 'dblclick'].includes(method) && args.length <= 1) {
    const opts = args.length
      ? options(literal(args[0]), ['button', 'clickCount'])
      : {}
    return {
      action: 'click',
      target,
      button: opts.button ?? 'left',
      count: method === 'dblclick' ? 2 : (opts.clickCount ?? 1),
    }
  }
  if (method === 'fill' && args.length === 1)
    return { action: 'type', target, text: literal(args[0]) }
  if (method === 'press' && args.length === 1)
    return { action: 'press', target, key: literal(args[0]) }
  if (method === 'selectOption' && args.length === 1) {
    const values = literal(args[0])
    return {
      action: 'select',
      target,
      values: Array.isArray(values) ? values : [values],
    }
  }
  if (method === 'dragTo' && args.length === 1)
    return {
      action: 'drag',
      source: target,
      target: readLocatorExpression(args[0], literal),
    }
  if (method === 'hover' && args.length === 0)
    return { action: 'hover', target }
  if (method === 'scrollIntoViewIfNeeded' && args.length === 0)
    return { action: 'reveal', target }
  throw invalid()
}
