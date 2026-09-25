import { randomUUID } from 'node:crypto'
import {
  PluginTaskSchema,
  type PluginInstallSource,
  type PluginTask,
  type PluginTaskAction,
  type PluginTaskPhase,
} from '@reflexion-os-studio/contracts'
import { ResourceEventEmitter, type EventNotifier } from '../events.js'
import { PluginPackageInstaller } from './installer.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const MAX_TASKS = 100

interface ManagedTask {
  task: PluginTask
  controller: AbortController
}

/** Runs plugin package work outside the JSON-RPC request lifecycle. */
export class PluginTaskManager {
  private readonly tasks = new Map<string, ManagedTask>()
  private readonly emitter: ResourceEventEmitter
  private lifecycleTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly installer: PluginPackageInstaller,
    notify: EventNotifier,
    private readonly onInstalled: (pluginId: string) => void,
  ) {
    this.emitter = new ResourceEventEmitter({ scope: 'runtime' }, notify)
  }

  startPreview(source: PluginInstallSource): PluginTask {
    return this.start('preview', null, async (managed) => {
      const result = await this.installer.preview(
        source,
        this.optionsFor(managed),
      )
      this.patch(managed, {
        manifest: result.manifest,
        installed: result.installed,
        pluginId: result.manifest.id,
      })
    })
  }

  startInstall(source: PluginInstallSource): PluginTask {
    return this.start('install', null, async (managed) => {
      const plugin = await this.installer.install(
        source,
        this.optionsFor(managed),
      )
      this.patch(managed, { plugin, pluginId: plugin.id })
      this.progress(managed, 'reloading', 95)
      this.onInstalled(plugin.id)
    })
  }

  startUpdate(pluginId: string): PluginTask {
    return this.start('update', pluginId, async (managed) => {
      const plugin = await this.installer.update(
        pluginId,
        this.optionsFor(managed),
      )
      this.patch(managed, { plugin })
      this.progress(managed, 'reloading', 95)
      this.onInstalled(plugin.id)
    })
  }

  list(): PluginTask[] {
    return [...this.tasks.values()]
      .map(({ task }) => task)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  cancel(taskId: string): PluginTask {
    const managed = this.tasks.get(taskId)
    if (!managed) throw new Error(`plugin task not found: ${taskId}`)
    if (!TERMINAL.has(managed.task.status)) managed.controller.abort()
    return managed.task
  }

  private start(
    action: PluginTaskAction,
    pluginId: string | null,
    execute: (managed: ManagedTask) => Promise<void>,
  ): PluginTask {
    const now = new Date().toISOString()
    const managed: ManagedTask = {
      task: PluginTaskSchema.parse({
        id: randomUUID(),
        action,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        pluginId,
        manifest: null,
        installed: null,
        plugin: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
      controller: new AbortController(),
    }
    this.tasks.set(managed.task.id, managed)
    this.prune()
    this.emit(managed)
    const scheduled = this.lifecycleTail.then(() => this.run(managed, execute))
    this.lifecycleTail = scheduled.catch(() => {})
    return managed.task
  }

  private async run(
    managed: ManagedTask,
    execute: (managed: ManagedTask) => Promise<void>,
  ): Promise<void> {
    this.patch(managed, { status: 'running' })
    try {
      await execute(managed)
      this.patch(managed, {
        status: 'completed',
        phase: 'completed',
        progress: 100,
      })
    } catch (error) {
      const cancelled =
        managed.controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      this.patch(managed, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled
          ? null
          : error instanceof Error
            ? error.message
            : String(error),
      })
    }
  }

  private optionsFor(managed: ManagedTask) {
    return {
      signal: managed.controller.signal,
      onProgress: (phase: PluginTaskPhase, progress: number) =>
        this.progress(managed, phase, progress),
    }
  }

  private progress(
    managed: ManagedTask,
    phase: PluginTaskPhase,
    progress: number,
  ): void {
    if (TERMINAL.has(managed.task.status)) return
    this.patch(managed, {
      phase,
      progress: Math.max(managed.task.progress, progress),
    })
  }

  private patch(managed: ManagedTask, patch: Partial<PluginTask>): void {
    managed.task = PluginTaskSchema.parse({
      ...managed.task,
      ...patch,
      updatedAt: new Date().toISOString(),
    })
    this.emit(managed)
  }

  private emit(managed: ManagedTask): void {
    this.emitter.next({ type: 'plugin.task.changed', task: managed.task })
  }

  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return
    for (const [id, { task }] of this.tasks) {
      if (TERMINAL.has(task.status)) this.tasks.delete(id)
      if (this.tasks.size <= MAX_TASKS) return
    }
  }
}
