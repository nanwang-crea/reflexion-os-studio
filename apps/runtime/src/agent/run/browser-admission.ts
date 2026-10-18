import type {
  ToolCallRequest,
  ToolRegistry,
} from '@reflexion-os-studio/agent-core'
import {
  AgentBrowserNavigateSchema,
  AgentBrowserPageSchema,
  AgentBrowserClickSchema,
  AgentBrowserTypeSchema,
  BrowserExecuteSchema,
} from '@reflexion-os-studio/contracts'
import { compileBrowserExecution } from '../../browser/agent/automation/script.js'

function browserArgumentError(name: string, args: unknown): string | null {
  const schemas = {
    'browser.navigate': AgentBrowserNavigateSchema,
    'browser.read': AgentBrowserPageSchema,
    'browser.close': AgentBrowserPageSchema,
    'browser.click': AgentBrowserClickSchema,
    'browser.type': AgentBrowserTypeSchema,
    'browser.execute': BrowserExecuteSchema,
  }
  if (!Object.hasOwn(schemas, name)) return null
  const schema = schemas[name as keyof typeof schemas]
  const parsed = schema.safeParse(args)
  if (!parsed.success)
    return parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
      .join('; ')
  if (name === 'browser.execute') {
    try {
      compileBrowserExecution(parsed.data)
    } catch {
      return 'script 不能编译为动作计划；只支持工具说明中的 page 动作、常量和有限 for...of，不支持任意 JS/DOM/Node。可改用 mode=actions 和 steps；已有参数未被清空，尚未执行任何浏览器动作。'
    }
  }
  return null
}

export function validBrowserArgs(name: string, args: unknown): boolean {
  return browserArgumentError(name, args) === null
}

export function validateToolAdmission(
  registry: ToolRegistry,
  request: ToolCallRequest,
) {
  const result = registry.validateRequest(request)
  if (!result.ok) return result
  const error = browserArgumentError(request.name, result.args)
  if (error === null) return result
  return {
    ok: false as const,
    result: {
      content: `${request.name} 参数无效：${error}。请按错误字段修正参数，不要原样重试。`,
      isError: true,
      code: 'invalid_request',
    },
  }
}

function redactUrlUserinfo(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate)
      if (!url.username && !url.password) return candidate
      url.username = 'redacted'
      url.password = 'redacted'
      return url.href
    } catch {
      return candidate
    }
  })
}

/** Preserve invalid parameters for diagnostics; keep the existing URL-userinfo boundary. */
export function redactBrowserCalls(
  calls: ToolCallRequest[],
): ToolCallRequest[] {
  return calls.map((call) => {
    if (!call.name.startsWith('browser.')) return call
    try {
      const args: unknown = JSON.parse(call.arguments)
      if (validBrowserArgs(call.name, args)) return call
      const normalized = JSON.stringify(args)
      const redacted = JSON.stringify(args, (_key, value: unknown) =>
        typeof value === 'string' ? redactUrlUserinfo(value) : value,
      )
      return normalized === redacted ? call : { ...call, arguments: redacted }
    } catch {
      // Malformed JSON still reaches the JSON validator, without echoing URL credentials.
      const redacted = call.arguments.replace(
        /\b(https?:\/\/)[^/\s]*@/gi,
        '$1redacted:redacted@',
      )
      return redacted === call.arguments
        ? call
        : { ...call, arguments: redacted }
    }
  })
}
