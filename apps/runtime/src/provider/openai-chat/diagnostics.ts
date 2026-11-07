import { ProviderError, redactProviderError } from '../provider-error.js'
import { mapFinishReason } from '../shared.js'
import type { StreamChatOptions } from '../types.js'

/** Counts only: never retain payloads, tool arguments, IDs, or event names. */
export class ChatStreamDiagnostics {
  readonly counts = {
    dataEvents: 0,
    jsonEvents: 0,
    doneEvents: 0,
    commentLines: 0,
    otherLines: 0,
    emptyDataEvents: 0,
    malformedEvents: 0,
    providerErrorEvents: 0,
    usageEvents: 0,
    choiceEvents: 0,
    nonzeroChoiceEvents: 0,
    finishFields: 0,
    nullFinishFields: 0,
    emptyFinishFields: 0,
    unsupportedFinishFields: 0,
    contentChars: 0,
    reasoningChars: 0,
    toolCallChunks: 0,
    toolArgumentChars: 0,
  }
  finishReason: ReturnType<typeof mapFinishReason> = null
  private rawFinishReason: unknown

  constructor(private readonly options: StreamChatOptions) {}

  observeChoice(choice: { index?: unknown; finish_reason?: unknown }): void {
    this.counts.choiceEvents += 1
    if (typeof choice.index === 'number' && choice.index !== 0)
      this.counts.nonzeroChoiceEvents += 1
  }

  observeFinish(choice: { finish_reason?: unknown } | undefined): void {
    if (!choice || !Object.hasOwn(choice, 'finish_reason')) return
    this.counts.finishFields += 1
    const raw = choice.finish_reason
    if (raw === null || raw === undefined) {
      this.counts.nullFinishFields += 1
      return
    }
    // 许多 OpenAI 兼容网关/自建服务在每个非终止 chunk 里都会带
    // finish_reason: ""（Go/Python 零值）。它与 null 同义 = "本轮还没结束"，
    // 不是未知终止值；当成 unsupported 会把一个正常收全的流判成协议错误。
    if (typeof raw === 'string' && raw.trim() === '') {
      this.counts.emptyFinishFields += 1
      return
    }
    const mapped = typeof raw === 'string' ? mapFinishReason(raw) : null
    // usage 空块、null/空串占位以及后续合法终止值不能覆盖首次不支持的值。
    if (mapped) {
      if (
        this.finishReason === null &&
        this.counts.unsupportedFinishFields === 0
      ) {
        this.finishReason = mapped
        this.rawFinishReason = raw
      }
    } else {
      if (this.counts.unsupportedFinishFields === 0) this.rawFinishReason = raw
      this.counts.unsupportedFinishFields += 1
    }
  }

  snapshot() {
    return {
      ...this.counts,
      terminalState:
        this.counts.unsupportedFinishFields > 0
          ? 'unsupported'
          : this.finishReason !== null
            ? 'valid'
            : this.counts.finishFields === 0
              ? 'absent'
              : this.counts.emptyFinishFields > 0 &&
                  this.counts.nullFinishFields === 0
                ? 'empty_only'
                : 'null_only',
      finishReason: this.finishReason,
    }
  }

  terminalError(): ProviderError | null {
    if (this.counts.unsupportedFinishFields > 0) {
      const raw = this.rawFinishReason
      // 对象/数组可能携带任意正文或凭据，只记录类型；字符串先脱敏再限长。
      const safe =
        typeof raw === 'string'
          ? JSON.stringify(
              redactProviderError(
                raw,
                this.options.apiKey,
                this.options.headers,
              ).slice(0, 40),
            )
          : `[${Array.isArray(raw) ? 'array' : typeof raw}]`
      return new ProviderError(
        'provider_protocol',
        `unsupported finish_reason (raw: ${safe})`,
      )
    }
    if (this.finishReason !== null) return null
    const raw =
      this.counts.finishFields === 0
        ? 'undefined'
        : this.counts.emptyFinishFields > 0 &&
            this.counts.nullFinishFields === 0
          ? 'empty'
          : 'null'
    return new ProviderError(
      'provider_protocol',
      `stream ended without a valid finish_reason (raw: ${raw})`,
      true,
    )
  }

  describe(receivedData: boolean, toolCalls: number): string {
    return `done: ${this.counts.doneEvents > 0}, receivedData: ${receivedData}, contentChars: ${this.counts.contentChars}, toolCalls: ${toolCalls}, streamStats: ${JSON.stringify(this.snapshot())}`
  }
}
