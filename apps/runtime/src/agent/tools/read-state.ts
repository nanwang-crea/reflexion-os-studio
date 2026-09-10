import type { ToolResult } from '@reflexion-os-studio/agent-core'

/**
 * Run 内文件读取状态：file.read 成功后记录 mtime 凭据，file.write/edit
 * 消费并回写新 mtime，file.move/delete 使相关路径失效。Rust 侧按 readToken
 * 做最终校验（先读后写强制 + 陈旧检测），本状态只让模型无需手工传参。
 * 生命周期与工具注册表一致（单次 Run）。
 */
export class FileReadState {
  private readonly tokens = new Map<string, number>()

  record(path: string, modifiedMs: number): void {
    this.tokens.set(path, modifiedMs)
  }

  token(path: string): number | undefined {
    return this.tokens.get(path)
  }

  invalidate(paths: string[]): void {
    for (const path of paths) {
      this.tokens.delete(path)
    }
  }
}

/** 从写/编辑成功结果取回新的 modifiedMs 记入状态；非 JSON 结果静默跳过。 */
export function recordResultMtime(
  state: FileReadState,
  path: string,
  result: ToolResult,
): void {
  try {
    const parsed: unknown = JSON.parse(result.content)
    if (typeof parsed === 'object' && parsed !== null) {
      const modifiedMs = (parsed as Record<string, unknown>).modifiedMs
      if (typeof modifiedMs === 'number') {
        state.record(path, modifiedMs)
      }
    }
  } catch {
    // 结果非 JSON 时跳过记录；后续编辑会触发先读校验，可自纠。
  }
}
