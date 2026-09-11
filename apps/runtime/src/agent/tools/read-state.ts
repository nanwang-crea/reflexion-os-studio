import type { ToolResult } from '@reflexion-os-studio/agent-core'

/** 与 Rust 侧 files::Revision 对齐的三字段读取凭据（mtime + size + sha256）。 */
export interface FileRevision {
  modifiedMs: number
  sizeBytes: number
  sha256: string
}

/**
 * 读取状态条目：凭据 + 是否来自完整读取。
 * 仅完整读取（行窗口与字符预算都未截断）发放的凭据可通过 file.write 覆盖校验；
 * 分页窗口的凭据只用于 file.edit 的陈旧检测。
 */
export interface FileReadRecord {
  revision: FileRevision
  complete: boolean
}

/**
 * Run 内文件读取状态：file.read / file.write / file.edit 成功后记录 revision
 * 凭据，file.write/edit 消费并回写新凭据，file.move/delete 使相关路径失效。
 * Rust 侧按 revision 做最终校验（先读后写强制 + 陈旧检测 + 完整读取要求），
 * 本状态只让模型无需手工传参。生命周期与工具注册表一致（单次 Run）。
 */
export class FileReadState {
  private readonly entries = new Map<string, FileReadRecord>()

  record(path: string, record: FileReadRecord): void {
    this.entries.set(path, record)
  }

  entry(path: string): FileReadRecord | undefined {
    return this.entries.get(path)
  }

  /** 兼容别名：旧式 mtime 凭据（读取时刻的修改时间）。 */
  token(path: string): number | undefined {
    return this.entries.get(path)?.revision.modifiedMs
  }

  invalidate(paths: string[]): void {
    for (const path of paths) {
      this.entries.delete(path)
    }
  }
}

/** 从读取类响应提取 revision 字段；字段缺失或类型不符时返回 undefined。 */
export function extractRevision(record: Record<string, unknown>): FileRevision | undefined {
  const revision = record.revision
  if (typeof revision !== 'object' || revision === null) return undefined
  const fields = revision as Record<string, unknown>
  if (typeof fields.modifiedMs !== 'number') return undefined
  if (typeof fields.sizeBytes !== 'number') return undefined
  if (typeof fields.sha256 !== 'string' || fields.sha256.length !== 64) return undefined
  return {
    modifiedMs: fields.modifiedMs,
    sizeBytes: fields.sizeBytes,
    sha256: fields.sha256,
  }
}

/**
 * 从写/编辑成功结果取回新 revision 记入状态（写/编辑产出的都是整文件凭据，
 * complete=true）；结果非 JSON 或缺 revision 时静默跳过（后续写操作会触发
 * 先读校验，可自纠）。
 */
export function recordResultRevision(
  state: FileReadState,
  path: string,
  result: ToolResult,
): void {
  try {
    const parsed: unknown = JSON.parse(result.content)
    if (typeof parsed === 'object' && parsed !== null) {
      const revision = extractRevision(parsed as Record<string, unknown>)
      if (revision !== undefined) {
        state.record(path, { revision, complete: true })
      }
    }
  } catch {
    // 结果非 JSON 时跳过记录；后续编辑会触发先读校验，可自纠。
  }
}
