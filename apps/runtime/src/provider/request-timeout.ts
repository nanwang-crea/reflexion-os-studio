import { DEFAULT_TIMEOUT_MS } from './shared.js'

/** Bound connection setup and idle reads without cutting off an active model. */
export class ProviderRequestTimeout {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  readonly signal: AbortSignal

  constructor(
    parent: AbortSignal,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal])
    this.refresh()
  }

  refresh(): void {
    this.dispose()
    if (this.signal.aborted) return
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new DOMException('Provider idle timeout', 'TimeoutError'),
        ),
      this.timeoutMs,
    )
    this.timer.unref()
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
