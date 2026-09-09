import type { Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { MemoryService } from './service.js'
import { MEMORY_JOB_MAX_ATTEMPTS } from '../../store/memoryJobs.js'

/**
 * 持久化 Memory Job Worker（W6）：
 * - 单 worker、并发度 1；只有没有前台 active Run 时才消费（空闲调度）；
 * - 新前台 Run 到达时中止正在进行的提取（AbortController），任务放回 pending；
 * - 可恢复错误最多重试 3 次（5s/30s/5min 退避）；配置缺失/认证失败/
 *   transcript 不合法直接 failed；
 * - job 只保存 runId；执行时经 Run 的 providerId 解析当前 Provider 配置，
 *   不持久化任何密钥。
 */
export class MemoryWorker {
  private running = false
  private abortedJob: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly store: Store,
    private readonly service: MemoryService,
  ) {}

  /** 尝试消费（空闲时）；由 Run 终态后与启动时触发。 */
  schedule(delayMs = 0): void {
    if (this.running) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.consume()
    }, delayMs)
  }

  /** 前台 Run 到达：中止后台提取，当前任务回 pending。 */
  preempt(): void {
    if (this.abortedJob !== null) {
      this.abortedJob.abort()
      this.abortedJob = null
    }
  }

  private async consume(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      let processed = 0
      // 单次唤醒最多消费 4 个任务，防止闲置期占满 Provider。
      while (processed < 4) {
        // 前台优先：存在 active Run 时不消费。
        if (this.hasForegroundRun()) break
        const job = this.store.memoryJobs.claimNext()
        if (job === null) break
        await this.process(job.runId)
        processed += 1
      }
    } finally {
      this.running = false
    }
  }

  private hasForegroundRun(): boolean {
    return this.store.runs.activeForAny() !== null
  }

  private async process(runId: string): Promise<void> {
    const run: Run | null = this.store.runs.get(runId)
    if (run === null || run.status !== 'completed') {
      this.store.memoryJobs.markPermanentFailure(
        runId,
        'run not found or not completed',
      )
      return
    }
    this.abortedJob = new AbortController()
    try {
      await this.service.processJob({
        run,
        signal: this.abortedJob.signal,
      })
      this.store.memoryJobs.markCompleted(runId)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // 被抢占：放回 pending 立即可重试（不计失败次数）。
        const job = this.store.memoryJobs.get(runId)
        if (job !== null && job.status === 'running') {
          this.store.memoryJobs.markRetryableFailure(runId, 'preempted')
        }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const permanent =
        message.includes('no embedding provider') ||
        message.includes('authentication') ||
        message.includes('transcript')
      if (permanent) {
        this.store.memoryJobs.markPermanentFailure(runId, message)
      } else {
        const outcome = this.store.memoryJobs.markRetryableFailure(
          runId,
          message,
        )
        if (outcome === 'pending') {
          // 退避后再次尝试消费。
          this.schedule(
            backoffDelay(this.store.memoryJobs.get(runId)?.attempts ?? 1),
          )
        }
      }
      // stderr 只写安全摘要（last_error 已在 store 层截断）。
      process.stderr.write(
        `[runtime] memory job failed (${runId.slice(0, 8)}): ${message.slice(0, 120)}\n`,
      )
    } finally {
      this.abortedJob = null
    }
  }
}

function backoffDelay(attempts: number): number {
  const backoffs = [5_000, 30_000, 300_000]
  return backoffs[Math.min(Math.max(attempts - 1, 0), backoffs.length - 1)]
}

export { MEMORY_JOB_MAX_ATTEMPTS }
