import type { ProviderProfile } from '@reflexion-os-studio/contracts'
import { EmitterRegistry, type EventNotifier } from '../events.js'
import { DEFAULT_SESSION_TITLE, type Store } from '../store/index.js'
import { generateSessionTitle } from './title.js'

export class SessionTitleService {
  private readonly emitters: EmitterRegistry
  private readonly jobs = new Map<string, AbortController>()
  private readonly attempted = new Set<string>()

  constructor(
    private readonly store: Store,
    notifier: EventNotifier,
  ) {
    this.emitters = new EmitterRegistry(notifier)
  }

  shouldGenerate(sessionId: string): boolean {
    return !this.attempted.has(sessionId)
  }

  schedule(input: {
    sessionId: string
    content: string
    placeholderTitle: string
    profile: ProviderProfile
    apiKey: string
    model: string
  }): void {
    if (this.jobs.has(input.sessionId)) return
    this.attempted.add(input.sessionId)
    const controller = new AbortController()
    this.jobs.set(input.sessionId, controller)
    void generateSessionTitle(input.content, {
      ...input,
      signal: controller.signal,
    })
      .then((title) => {
        if (!title || controller.signal.aborted) return
        const current = this.store.sessions.get(input.sessionId)
        if (
          !current ||
          (current.title !== input.placeholderTitle &&
            current.title !== DEFAULT_SESSION_TITLE)
        ) {
          return
        }
        this.store.sessions.rename(input.sessionId, title)
        this.emitUpdated(input.sessionId)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          process.stderr.write(
            `[runtime] session title generation failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
        }
      })
      .finally(() => {
        if (this.jobs.get(input.sessionId) === controller) {
          this.jobs.delete(input.sessionId)
        }
      })
  }

  emitUpdated(sessionId: string): void {
    const session = this.store.sessions.get(sessionId)
    if (!session) return
    this.emitters
      .for({ scope: 'session', sessionId })
      .next({ type: 'session.updated', session })
  }

  markManuallyEdited(sessionId: string): void {
    this.attempted.add(sessionId)
    this.jobs.get(sessionId)?.abort()
    this.jobs.delete(sessionId)
  }

  clearSession(sessionId: string): void {
    this.jobs.get(sessionId)?.abort()
    this.jobs.delete(sessionId)
    this.attempted.delete(sessionId)
    this.emitters.evict({ scope: 'session', sessionId })
  }

  dispose(): void {
    for (const controller of this.jobs.values()) controller.abort()
    this.jobs.clear()
    this.emitters.clear()
  }
}
