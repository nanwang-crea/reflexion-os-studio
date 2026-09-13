import type { Terminal as XTerminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type {
  Terminal as TerminalMeta,
  TerminalStatus,
} from '@reflexion-os-studio/runtime-client'
import type { TerminalInputChannel } from './input-channel'
import { PreMountBuffer } from './output-buffer'

export type { TerminalMeta, TerminalStatus }

/**
 * 单个终端的宿主状态。xterm/容器延迟到首次展示创建（内容历史唯一存于
 * xterm，不复制三份）；离屏期靠 pendingOutput 缓冲新输出，见 spec §5。
 */
export interface TerminalInstance {
  meta: TerminalMeta
  projectId: string
  consumerId: string
  term: XTerminal | null
  fit: FitAddon | null
  container: HTMLDivElement | null
  input: TerminalInputChannel | null
  /** 未展示终端的挂载前输出缓存（有界丢最旧 + 截断标记）。 */
  buffer: PreMountBuffer
  ack: { pendingHighest: number; lastSent: number; inFlight: boolean }
  resizePending: { rows: number; cols: number } | null
  resizeInFlight: boolean
  resizeTimer: ReturnType<typeof setTimeout> | null
  observer: ResizeObserver | null
  closing: boolean
}

export const DEAD_STATUSES: ReadonlySet<TerminalStatus> = new Set([
  'exited',
  'closed',
  'failed',
  'disconnected',
])
