import type { FileRevision } from '@reflexion-os-studio/contracts'

export interface WorkspaceFileRecord {
  revision: FileRevision
  /** 凭据是否来自完整读取；分页窗口的凭据不足以授权覆盖整文件。 */
  complete: boolean
}

/**
 * 工作区文件读取凭据登记：workspace.read_file 成功后记录 revision，
 * workspace.write_file（UI 保存）查表注入、消费并回写——与 agent 链路
 * read-state.ts 同一模式，前端零凭据搬运。生命周期随 Runtime 进程；
 * Rust 侧仍以 revision 做最终陈旧校验，本登记只保证"编辑器确实读过
 * 该文件的当前版本"。
 */
export class WorkspaceFileState {
  private readonly entries = new Map<string, WorkspaceFileRecord>()

  private key(workspaceRoot: string, path: string): string {
    return `${workspaceRoot}\u0000${path}`
  }

  record(workspaceRoot: string, path: string, rec: WorkspaceFileRecord): void {
    this.entries.set(this.key(workspaceRoot, path), rec)
  }

  entry(workspaceRoot: string, path: string): WorkspaceFileRecord | undefined {
    return this.entries.get(this.key(workspaceRoot, path))
  }
}

/** Runtime 进程级单例（与 workspaceIndexer 同生命周期）。 */
export const workspaceFileState = new WorkspaceFileState()
