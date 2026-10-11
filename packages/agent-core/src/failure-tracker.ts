import path from 'node:path'
import type { ToolCallRequest, ToolResult } from './types.js'

/** 同一操作/资源/错误累计四次后拦截；参数变化不代表进展。 */
export class FailureTracker {
  private readonly failures = new Map<string, Map<string, number>>()
  private readonly revisions = new Map<string, string>()

  clear(): void {
    this.failures.clear()
  }

  exhausted(request: ToolCallRequest): boolean {
    const resource = resourceFor(request)
    return (
      resource !== null &&
      [
        ...(this.failures.get(`${request.name}:${resource}`)?.values() ?? []),
      ].some((count) => count >= 4)
    )
  }

  record(
    request: ToolCallRequest,
    result: ToolResult,
    mutation: boolean,
  ): void {
    const resource = resourceFor(request)
    if (resource === null) return
    const key = `${request.name}:${resource}`
    if (result.isError) {
      const category = result.code ?? 'tool_error'
      const categories = this.failures.get(key) ?? new Map<string, number>()
      categories.set(category, (categories.get(category) ?? 0) + 1)
      this.failures.set(key, categories)
      return
    }
    let revision: string | undefined
    try {
      const data = JSON.parse(result.content)
      if (typeof data?.revision?.sha256 === 'string')
        revision = data.revision.sha256
    } catch {
      // 非文件结果不以正文变化作为外部状态变化的证据。
    }
    const previousRevision = this.revisions.get(resource)
    if (revision !== undefined) this.revisions.set(resource, revision)
    if (
      (mutation && request.name !== 'manage_plan') ||
      (revision !== undefined &&
        previousRevision !== undefined &&
        revision !== previousRevision)
    ) {
      for (const operation of this.failures.keys()) {
        if (operation.endsWith(`:${resource}`)) this.failures.delete(operation)
      }
    } else {
      // 成功只清除此操作；file.read 成功不会清除 file.edit 的失败。
      this.failures.delete(key)
    }
  }
}

function resourceFor(request: ToolCallRequest): string | null {
  try {
    const args = JSON.parse(request.arguments)
    if (typeof args.path === 'string') {
      const normalized = path.posix.normalize(args.path.replaceAll('\\', '/'))
      return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized
    }
    for (const key of ['url', 'serverId', 'sessionId', 'planId']) {
      if (typeof args[key] === 'string') return `${key}=${args[key]}`
    }
  } catch {
    // 无法识别资源时仅使用既有精确指纹保护。
  }
  return null
}
