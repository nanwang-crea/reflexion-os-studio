import type { Terminal as XTerminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type {
  Terminal as TerminalBase,
  TerminalStatus,
} from '@reflexion-os-studio/runtime-client'
import type { TerminalInputChannel } from './input-channel'
import { PreMountBuffer } from './output-buffer'

/**
 * 契约 Terminal 实体 + 前端本地字段。errorMessage 来自 terminal.state
 * 事件的可选失败原因（契约实体尚未落该字段，defensive：可能缺省）。
 */
export type TerminalMeta = TerminalBase & { errorMessage?: string }
export type { TerminalStatus }

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
  /** attach 竞态失效标记（M-1）：not_found 且无 state 事件到达 → 只读 + 标题「终端已失效」。 */
  expired: boolean
}

export const DEAD_STATUSES: ReadonlySet<TerminalStatus> = new Set([
  'exited',
  'closed',
  'failed',
  'disconnected',
])
