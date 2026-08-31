import { stat } from 'node:fs/promises'
import type {
  WorkspaceIndexSnapshot,
  WorkspaceIndexStatus,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import type { Store } from '../store/index.js'
import { scanWorkspace } from './walker.js'

/** 进度事件最小间隔：大工作区防通知风暴。 */
const PROGRESS_THROTTLE_MS = 400

/**
 * Workspace 索引工作器（Phase 1B）：每项目异步扫描，不进 Chat 主流程。
 * 生命周期：start（接管/重启）→ scanning → completed/failed；cancel 可随时中断，
 * 中断后回退到上一次完整快照。stale 由查询时按工作区根目录 mtime 推导
 * （v1 启发式：只感知根目录自身的变更，深度文件变化需手动重新索引）。
 */
export class WorkspaceIndexer {
  private readonly controllers = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
  ) {}

  /** 异步启动/重启一次索引；内部自吞异常，永远不向调用方抛。 */
  async start(projectId: string, workspaceRoot: string): Promise<void> {
    this.cancel(projectId)
    const controller = new AbortController()
    this.controllers.set(projectId, controller)

    const previous = this.store.workspaceIndex.get(projectId)
    const version = (previous?.version ?? 0) + 1
    const emitter = new RunEventEmitter(projectId, this.notifier)
    const scanning: WorkspaceIndexSnapshot = {
      projectId,
      status: 'scanning',
      version,
      startedAt: new Date().toISOString(),
      completedAt: null,
      staleAt: null,
      fileCount: 0,
      dirCount: 0,
      totalBytes: 0,
      extStats: [],
      truncated: false,
      error: null,
    }
    this.store.workspaceIndex.upsert(scanning)

    let lastProgressAt = 0
    // 取消/被新扫描接管时回退到上一份完整快照；只有仍持有当前 controller
    // 才允许写回，防止旧扫描与新扫描互相覆盖。
    const restorePrevious = (): void => {
      if (this.controllers.get(projectId) !== controller) return
      this.store.workspaceIndex.upsert(
        previous ?? {
          projectId,
          status: 'idle',
          version,
          startedAt: null,
          completedAt: null,
          staleAt: null,
          fileCount: 0,
          dirCount: 0,
          totalBytes: 0,
          extStats: [],
          truncated: false,
          error: null,
        },
      )
    }

    try {
      const stats = await scanWorkspace(
        workspaceRoot,
        controller.signal,
        (files, dirs) => {
          const now = Date.now()
          if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return
          lastProgressAt = now
          emitter.next({
            type: 'workspace.index.progress',
            projectId,
            version,
            files,
            dirs,
          })
        },
      )
      if (controller.signal.aborted) {
        restorePrevious()
        return
      }
      const snapshot: WorkspaceIndexSnapshot = {
        projectId,
        status: 'completed',
        version,
        startedAt: scanning.startedAt,
        completedAt: new Date().toISOString(),
        staleAt: null,
        fileCount: stats.files,
        dirCount: stats.dirs,
        totalBytes: stats.totalBytes,
        extStats: stats.extStats,
        truncated: stats.truncated,
        error: null,
      }
      this.store.workspaceIndex.upsert(snapshot)
      emitter.next({ type: 'workspace.index.completed', projectId, snapshot })
    } catch (error) {
      if (controller.signal.aborted) {
        restorePrevious()
        return
      }
      // 已被新扫描接管：不写回、不广播，把状态让渡给新扫描。
      if (this.controllers.get(projectId) !== controller) return
      const message = error instanceof Error ? error.message : String(error)
      // 失败回退到上一份完整快照（若有），否则明确 idle。
      restorePrevious()
      emitter.next({
        type: 'workspace.index.failed',
        projectId,
        error: message,
      })
    } finally {
      if (this.controllers.get(projectId) === controller) {
        this.controllers.delete(projectId)
      }
    }
  }

  /** 中断进行中的索引；返回是否确实取消了运行中的扫描。 */
  cancel(projectId: string): boolean {
    const controller = this.controllers.get(projectId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** 查询快照：completed 时按根目录 mtime 推导 stale（过期标记不落盘）。 */
  async snapshotFor(projectId: string): Promise<WorkspaceIndexSnapshot | null> {
    const snapshot = this.store.workspaceIndex.get(projectId)
    if (snapshot === null || snapshot.status !== 'completed') return snapshot
    const project = this.store.projects.get(projectId)
    if (!project || project.folderPath === '') return snapshot
    try {
      const info = await stat(project.folderPath)
      if (
        snapshot.completedAt !== null &&
        info.mtimeMs > Date.parse(snapshot.completedAt)
      ) {
        return {
          ...snapshot,
          status: 'stale' as WorkspaceIndexStatus,
          staleAt: new Date().toISOString(),
        }
      }
    } catch {
      // 根目录不可访问：保持 completed，不做推断。
    }
    return snapshot
  }
}
