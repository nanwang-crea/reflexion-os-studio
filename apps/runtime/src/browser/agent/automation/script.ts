import {
  readLocatorExpression,
  translatePlaywrightCall,
} from './playwright-syntax.js'
import { parse, type Node } from 'acorn'
import {
  BrowserExecuteSchema,
  BrowserPlanSchema,
  type BrowserPlan,
} from '@reflexion-os-studio/contracts'

type Ast = Node & Record<string, unknown>
const node = (value: unknown) => value as Ast
const denied = () => new Error('browser_script_invalid')

/** A static action language, never eval/vm or a page/Node capability object. */
export function compileBrowserExecution(raw: unknown): BrowserPlan {
  const input = BrowserExecuteSchema.parse(raw)
  if (input.mode === 'actions') return validatePlan(input)
  try {
    const program = parse(input.script, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    })
    const steps: unknown[] = []
    let visited = 0
    const literal = (
      raw: unknown,
      env: Map<string, unknown>,
      depth = 0,
    ): unknown => {
      if (++visited > 4000 || depth > 12) throw denied()
      const ast = node(raw)
      if (
        ast.type === 'Literal' &&
        (ast.value === null ||
          ['string', 'number', 'boolean'].includes(typeof ast.value))
      )
        return ast.value
      if (ast.type === 'CallExpression')
        return readLocatorExpression(ast, (value) =>
          literal(value, env, depth + 1),
        )
      if (ast.type === 'Identifier' && env.has(String(ast.name)))
        return env.get(String(ast.name))
      if (
        ast.type === 'UnaryExpression' &&
        ast.operator === '-' &&
        typeof node(ast.argument).value === 'number'
      )
        return -Number(node(ast.argument).value)
      if (ast.type === 'ArrayExpression')
        return (ast.elements as unknown[]).map((item) =>
          literal(item, env, depth + 1),
        )
      if (ast.type === 'ObjectExpression') {
        const object: Record<string, unknown> = Object.create(null)
        for (const rawProperty of ast.properties as unknown[]) {
          const property = node(rawProperty)
          if (
            property.type !== 'Property' ||
            property.computed ||
            property.method ||
            property.kind !== 'init'
          )
            throw denied()
          const key = String(
            node(property.key).name ?? node(property.key).value,
          )
          if (
            ['__proto__', 'prototype', 'constructor'].includes(key) ||
            Object.hasOwn(object, key)
          )
            throw denied()
          object[key] = literal(property.value, env, depth + 1)
        }
        return object
      }
      throw denied()
    }
    const statements = (
      body: unknown[],
      outer: Map<string, unknown>,
      depth = 0,
    ) => {
      if (depth > 6) throw denied()
      const env = new Map(outer)
      for (const rawStatement of body) {
        if (++visited > 4000 || steps.length > 20) throw denied()
        const statement = node(rawStatement)
        if (
          statement.type === 'VariableDeclaration' &&
          statement.kind === 'const'
        ) {
          for (const declaration of statement.declarations as unknown[]) {
            const { id, init } = node(declaration)
            const name = String(node(id).name)
            if (
              node(id).type !== 'Identifier' ||
              name === 'page' ||
              env.has(name)
            )
              throw denied()
            env.set(name, literal(init, env))
          }
          continue
        }
        if (statement.type === 'ForOfStatement' && !statement.await) {
          const left = node(statement.left)
          const declarations = left.declarations as unknown[]
          if (
            left.type !== 'VariableDeclaration' ||
            left.kind !== 'const' ||
            declarations.length !== 1
          )
            throw denied()
          const id = node(node(declarations[0]).id)
          if (id.type !== 'Identifier' || id.name === 'page') throw denied()
          const values = literal(statement.right, env)
          if (
            !Array.isArray(values) ||
            values.length > 20 ||
            node(statement.body).type !== 'BlockStatement'
          )
            throw denied()
          for (const value of values)
            statements(
              node(statement.body).body as unknown[],
              new Map([...env, [String(id.name), value]]),
              depth + 1,
            )
          continue
        }
        if (
          statement.type !== 'ExpressionStatement' ||
          node(statement.expression).type !== 'AwaitExpression'
        )
          throw denied()
        const call = node(node(statement.expression).argument)
        const translated = translatePlaywrightCall(call, (value) =>
          literal(value, env),
        )
        if (translated !== undefined) {
          steps.push(translated)
          continue
        }
        const callee = node(call.callee)
        if (
          call.type !== 'CallExpression' ||
          call.optional ||
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          node(callee.object).type !== 'Identifier' ||
          node(callee.object).name !== 'page'
        )
          throw denied()
        const args = call.arguments as unknown[]
        if (args.length > 1) throw denied()
        const params = args.length ? literal(args[0], env) : {}
        if (
          !params ||
          typeof params !== 'object' ||
          Array.isArray(params) ||
          Object.hasOwn(params, 'action')
        )
          throw denied()
        steps.push({ action: String(node(callee.property).name), ...params })
      }
    }
    statements(program.body, new Map())
    return validatePlan(
      BrowserPlanSchema.parse({
        page: input.page,
        timeoutMs: input.timeoutMs,
        mode: 'actions',
        steps,
      }),
    )
  } catch {
    throw denied()
  }
}
function validatePlan(plan: BrowserPlan): BrowserPlan {
  if (
    plan.steps.filter((step) => step.action === 'screenshot').length > 4 ||
    plan.steps.some(
      (step) =>
        step.action === 'goto' && new URL(step.url).origin !== plan.page.origin,
    )
  )
    throw denied()
  return plan
}
