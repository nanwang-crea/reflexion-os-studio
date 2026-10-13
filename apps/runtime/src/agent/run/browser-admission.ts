import type {
  ToolCallRequest,
  ToolRegistry,
} from '@reflexion-os-studio/agent-core'
import {
  AgentBrowserNavigateSchema,
  AgentBrowserPageSchema,
} from '@reflexion-os-studio/contracts'
import { isIP } from 'node:net'
import { publicIp } from '../../browser/agent/security/network.js'

export function validBrowserArgs(name: string, args: unknown): boolean {
  if (!['browser.navigate', 'browser.read', 'browser.close'].includes(name))
    return true
  const schema =
    name === 'browser.navigate'
      ? AgentBrowserNavigateSchema
      : AgentBrowserPageSchema
  const input = schema.safeParse(args)
  if (!input.success) return false
  if ('url' in input.data) {
    const host = new URL(input.data.url).hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !publicIp(host)) return false
  }
  return true
}
export function validateToolAdmission(
  registry: ToolRegistry,
  request: ToolCallRequest,
) {
  const result = registry.validateRequest(request)
  if (!result.ok || validBrowserArgs(request.name, result.args)) return result
  return {
    ok: false as const,
    result: {
      content: '浏览器参数无效或包含敏感内容',
      isError: true,
      code: 'invalid_request',
    },
  }
}
export function redactBrowserCalls(
  calls: ToolCallRequest[],
): ToolCallRequest[] {
  return calls.map((call) => {
    try {
      if (validBrowserArgs(call.name, JSON.parse(call.arguments))) return call
    } catch {
      if (!call.name.startsWith('browser.')) return call
    }
    return { ...call, arguments: '{}' }
  })
}
