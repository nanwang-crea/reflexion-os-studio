import { utf8Bytes } from './binary'

/**
 * 未展示终端的挂载前输出缓冲（有界，spec §5）。xterm 是内容的唯一历史
 * 载体（不复制三份）；终端 attach 后但面板从未打开时，输出先落这里，
 * 超上限丢最旧并插一次「面板从未打开」标记帧——展示后只见新输出。
 * WHY 丢最旧而非拒绝：后端 attach 后即开始按序投递，前端不能停 ack
 * （否则额度填满会暂停读 PTY，卡死从没看过的 shell）。
 */
const BUFFER_CAP = 512 * 1024
const TRUNCATION_MARKER = utf8Bytes('[输出已截断——面板从未打开]\r\n')

export class PreMountBuffer {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private dropped = false

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.bytes += bytes.length
    while (this.bytes > BUFFER_CAP && this.chunks.length > 0) {
      const oldest = this.chunks.shift() as Uint8Array
      this.bytes -= oldest.length
      this.dropped = true
    }
  }

  /** 取走全部待发字节（丢过时前置一次性标记帧）并清空。 */
  drain(): Uint8Array[] {
    const chunks = this.dropped
      ? [TRUNCATION_MARKER, ...this.chunks]
      : this.chunks
    this.chunks = []
    this.bytes = 0
    this.dropped = false
    return chunks
  }
}
