import { randomUUID } from 'node:crypto'
import { RootMutationCoordinator } from '../../agent/delegation/mutations.js'

export class WorkflowExecutionContext {
  private resolveSettled!: () => void
  readonly settled = new Promise<void>((resolve) => {
    this.resolveSettled = resolve
  })
  finish(): void {
    this.resolveSettled()
  }
  readonly controller = new AbortController()
  readonly mutations = new RootMutationCoordinator()
  readonly active = new Map<string, Promise<void>>()
  readonly reservations = new Map<string, number>()
  readonly permissionDomainId = randomUUID()
  driving = false
  closed = false
  failure: string | null = null
  lastActiveAt: number | null = null
  timer: ReturnType<typeof setTimeout> | undefined
  confirmationTimer: ReturnType<typeof setTimeout> | undefined

  clearTimers(): void {
    clearTimeout(this.timer)
    clearTimeout(this.confirmationTimer)
  }
}
