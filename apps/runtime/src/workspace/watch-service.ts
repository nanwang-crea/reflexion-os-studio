import { randomUUID } from 'node:crypto'
import type { EventNotifier } from '../events.js'
import { EmitterRegistry } from '../events.js'
import type { SystemRuntimeClient } from '../system.js'

interface WatchRecord {
  projectId: string
  path: string
}

export class WorkspaceWatchService {
  private readonly watches = new Map<string, WatchRecord>()
  private readonly emitters: EmitterRegistry

  constructor(
    private readonly system: SystemRuntimeClient,
    notify: EventNotifier,
  ) {
    this.emitters = new EmitterRegistry(notify)
  }

  async watch(projectId: string, workspaceRoot: string, path: string) {
    const watchId = randomUUID()
    await this.system.request('file.watch', {
      workspaceRoot,
      path,
      watchId,
    })
    this.watches.set(watchId, { projectId, path })
    return { watchId }
  }

  async unwatch(watchId: string): Promise<boolean> {
    const existed = this.watches.delete(watchId)
    if (!existed) return false
    try {
      await this.system.request('file.unwatch', { watchId })
    } catch {
      // System Runtime 重启会自然释放 watcher；本地登记仍必须收敛。
    }
    return true
  }

  handleNotification(method: string, params: unknown): void {
    if (method !== 'file.changed' || !isChangedParams(params)) return
    const record = this.watches.get(params.watchId)
    if (!record) return
    this.emitters.for({ scope: 'project', projectId: record.projectId }).next({
      type: 'workspace.changed',
      path: record.path,
      kind: params.kind,
    })
  }

  clear(): void {
    this.watches.clear()
    this.emitters.clear()
  }
}

function isChangedParams(
  value: unknown,
): value is { watchId: string; path: string; kind: string } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.watchId === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.kind === 'string'
  )
}
