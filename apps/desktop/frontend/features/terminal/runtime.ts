import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  attachTerminal,
  resizeTerminal,
  writeTerminal,
} from '../../api/terminal'
import { showToast } from '../../components/Toast'
import { decodeBase64, encodeBase64, utf8Length } from './binary'
import { InputSendError, TerminalInputChannel } from './input-channel'
import { AckTracker } from './ack-tracker'
import { PreMountBuffer } from './output-buffer'
import {
  extractErrorCode,
  isUncertainError,
  notifyTerminalError,
} from './notices'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { transport } from '../../lib/transport'
import { DEAD_STATUSES } from './types'
import type { TerminalInstance, TerminalMeta } from './types'

/**
 * 终端实例运行时（W3）：单例内部机制——实例表、离屏宿主 DOM、
 * transport 事件路由（单订阅）、输入发送、输出 ack、尺寸同步。
 * 与 manager.ts（项目/标签编排 + React 快照）分工：这里管"终端"，
 * 那里管"标签页"。
 */

/** 粘贴上限：超限整单拒绝、不截断（spec §4——半截粘贴比拒绝更危险）。 */
const PASTE_LIMIT_BYTES = 1024 * 1024
const RESIZE_DEBOUNCE_MS = 50
const HOST_DEFAULT_WIDTH = 800
const HOST_DEFAULT_HEIGHT = 300
/** attach not_found 竞态：无 state 事件到达时判定标签失效的等待窗口。 */
const ATTACH_EXPIRY_MS = 2000

const XTERM_THEME = {
  background: '#1e1e1e', // 与 --bg-editor 同值
  foreground: '#ececec',
  cursor: '#d0d0d0',
  selectionBackground: '#3a3a3a',
}

export interface TerminalRuntimeOptions {
  /** 状态变化上抛（manager 快照失效 + React 通知）。 */
  notify: () => void
  /** 当前应可见的终端（项目 + 标签）；null = 全部离屏。 */
  getVisible: () => { projectId: string; terminalId: string } | null
}

export class TerminalRuntime {
  private readonly instances = new Map<string, TerminalInstance>()
  private readonly acks = new AckTracker(() => this.instances.values())
  private host: HTMLDivElement | null = null
  private hostSize = {
    width: HOST_DEFAULT_WIDTH,
    height: HOST_DEFAULT_HEIGHT,
  }
  private slotEl: HTMLElement | null = null

  constructor(private readonly options: TerminalRuntimeOptions) {}

  init(): void {
    this.ensureHost()
    transport.onEvent(this.handleEvent)
  }

  get(terminalId: string): TerminalInstance | undefined {
    return this.instances.get(terminalId)
  }

  all(): IterableIterator<TerminalInstance> {
    return this.instances.values()
  }

  register(meta: TerminalMeta): TerminalInstance {
    const inst: TerminalInstance = {
      meta,
      projectId: meta.projectId,
      consumerId: crypto.randomUUID(),
      term: null,
      fit: null,
      container: null,
      input: null,
      buffer: new PreMountBuffer(),
      ack: { pendingHighest: -1, lastSent: -1, inFlight: false },
      resizePending: null,
      resizeInFlight: false,
      resizeTimer: null,
      observer: null,
      closing: false,
      expired: false,
    }
    inst.input = new TerminalInputChannel({
      send: (seq, bytes) => this.sendInput(inst, seq, bytes),
      onHalt: (message) => showToast(message, 'error'),
      // Runtime 输入序号基线为 0，首批 seq=1（apps/runtime terminal/records.ts）。
      seqBaseline: 0,
    })
    this.instances.set(meta.terminalId, inst)
    return inst
  }

  disposeInstance(terminalId: string): void {
    const inst = this.instances.get(terminalId)
    if (!inst) return
    this.instances.delete(terminalId)
    inst.input?.dispose()
    inst.observer?.disconnect()
    if (inst.resizeTimer !== null) clearTimeout(inst.resizeTimer)
    inst.term?.dispose()
    inst.container?.remove()
    this.options.notify()
  }

  async attach(inst: TerminalInstance): Promise<void> {
    try {
      const { terminal } = await attachTerminal(
        inst.projectId,
        inst.meta.terminalId,
        inst.consumerId,
      )
      inst.meta = terminal
      inst.expired = false
    } catch (error) {
      console.debug('[terminal] attach failed', error)
      const code = extractErrorCode(error)
      if (code === 'terminal_not_found') {
        // create 与 attach 之间被后端回收：等终态 state 事件；没等到即失效。
        this.watchAttachLoss(inst)
      } else if (
        code !== 'terminal_not_running' &&
        !DEAD_STATUSES.has(inst.meta.status)
      ) {
        // not_running 交给 terminal.state 事件驱动 UI；meta 已终态时 attach
        // 失败无信息量；其余意外失败必须可见。
        notifyTerminalError(error, '终端绑定输出失败')
      }
    }
    this.options.notify()
  }

  /** not_found 且 2s 内无 terminal.state 事件到达：标签降级为只读失效态。 */
  private watchAttachLoss(inst: TerminalInstance): void {
    const statusAtCatch = inst.meta.status
    setTimeout(() => {
      if (this.instances.get(inst.meta.terminalId) !== inst) return
      if (inst.expired || inst.meta.status !== statusAtCatch) return
      inst.expired = true
      inst.meta = { ...inst.meta, status: 'disconnected' } // 只读 + dead 态 UI
      this.options.notify()
    }, ATTACH_EXPIRY_MS)
  }

  /**
   * 首次展示时创建 xterm。容器挂在管理器自建的**离屏宿主**上：
   * position:fixed; left:-99999px + visibility:hidden——v6 DOM renderer
   * 需要布局盒才能正确测量字符尺寸与滚动区，display:none 会静默破坏
   * 渲染（W1 验证结论），所以用「有布局的离屏」而不是「无布局的隐藏」。
   */
  ensureTerm(inst: TerminalInstance): void {
    if (inst.term !== null) return
    this.ensureHost()
    const container = document.createElement('div')
    container.style.width = '100%'
    container.style.height = '100%'
    const term = new XTerminal({
      rows: inst.meta.rows,
      cols: inst.meta.cols,
      scrollback: 5000,
      fontSize: 12,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      theme: XTERM_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // 捕获阶段先于 xterm textarea 处理器，才能对超限粘贴整单拒绝。
    container.addEventListener(
      'paste',
      (event) => {
        const text = event.clipboardData?.getData('text') ?? ''
        if (utf8Length(text) > PASTE_LIMIT_BYTES) {
          event.preventDefault()
          event.stopImmediatePropagation()
          showToast('粘贴内容超过 1 MiB，已拒绝（不截断发送）', 'error')
        }
      },
      true,
    )
    inst.term = term
    inst.fit = fit
    inst.container = container
    // open 前容器必须已在文档内（xterm 需真实布局测量字符尺寸）：
    // 先落离屏宿主，render() 再把激活者搬进可见槽位。
    this.host?.appendChild(container)
    term.open(container)
    term.onData((data) => {
      if (inst.meta.status !== 'running') return // 断开/退出标签只读
      inst.input?.push(data)
    })
    for (const chunk of inst.buffer.drain()) term.write(chunk)
    fit.fit() // 离屏宿主有真实尺寸，fit 安全
    this.syncGeometry(inst)
  }

  // ---------------- 事件路由（单订阅，永久接线） ----------------

  private handleEvent = (event: RuntimeEvent): void => {
    if (event.scope !== 'terminal') return
    const inst = this.instances.get(event.terminalId)
    if (!inst) return
    if (event.type === 'terminal.output') {
      // consumerId 守卫：换消费者/重挂后的旧代际事件一律丢弃。
      if (event.consumerId !== inst.consumerId) return
      const bytes = decodeBase64(event.data)
      if (inst.term) {
        inst.term.write(bytes, () =>
          this.acks.noteConsumed(inst, event.outputSeq),
        )
      } else {
        inst.buffer.push(bytes)
        // 未展示即视为消费：照常 ack，否则后端额度填满会暂停读 PTY，
        // 把从没看过的终端的 shell 卡死。
        this.acks.noteConsumed(inst, event.outputSeq)
      }
      return
    }
    // terminal.state 到达即证明后端仍跟踪该终端：撤销失效猜测（M-1）。
    inst.expired = false
    inst.meta = {
      ...inst.meta,
      status: event.status,
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      // 失败原因（契约事件可选字段，可能缺省）：随 meta 留存供状态标题展示。
      ...(event.errorMessage !== undefined
        ? { errorMessage: event.errorMessage }
        : {}),
    }
    if (event.status === 'closing') inst.closing = true
    this.options.notify()
  }

  // ---------------- 输入 ----------------

  private async sendInput(
    inst: TerminalInstance,
    seq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      await writeTerminal(
        inst.projectId,
        inst.meta.terminalId,
        seq,
        encodeBase64(bytes),
      )
    } catch (error) {
      throw new InputSendError(
        isUncertainError(error) ? 'uncertain' : 'definite',
        extractErrorCode(error) ?? 'unknown',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  // ---------------- 槽位接管与尺寸同步 ----------------

  /** 面板挂载时把激活容器搬进真实槽位；卸载/收起回离屏宿主（绝不 dispose）。 */
  attachSlot(el: HTMLElement | null): void {
    if (el !== null && el.clientWidth > 0) {
      this.hostSize = { width: el.clientWidth, height: el.clientHeight }
    }
    this.slotEl = el
    this.applyHostSize()
    this.render()
  }

  detachSlot(el: HTMLElement): void {
    if (this.slotEl === el) this.slotEl = null
    this.render()
  }

  /** 激活标签变化后重排容器（离屏宿主与真实槽位之间 re-parent）。 */
  render(): void {
    const visible = this.options.getVisible()
    for (const inst of this.instances.values()) {
      if (inst.container === null) continue
      const onScreen =
        this.slotEl !== null &&
        visible !== null &&
        visible.projectId === inst.projectId &&
        visible.terminalId === inst.meta.terminalId
      if (onScreen) {
        if (inst.container.parentElement !== this.slotEl) {
          this.slotEl?.appendChild(inst.container)
        }
        this.setOnScreen(inst, true)
      } else {
        this.host?.appendChild(inst.container)
        this.setOnScreen(inst, false)
      }
    }
  }

  /**
   * ResizeObserver 只在容器真实上屏期间挂接；隐藏时断开且**绝不 fit**
   * （W1 验证：零尺寸下 fit 静默无效，还会把网格打成 1x1 再送错尺寸）。
   */
  private setOnScreen(inst: TerminalInstance, onScreen: boolean): void {
    if (onScreen && inst.container !== null) {
      if (inst.observer === null) {
        inst.observer = new ResizeObserver(() => this.onContainerResize(inst))
      }
      inst.observer.observe(inst.container)
      this.syncGeometry(inst) // 槽位尺寸与上次记录可能已不同（收起期间调高/改宽）
      return
    }
    inst.observer?.disconnect()
  }

  private onContainerResize(inst: TerminalInstance): void {
    if (inst.term === null || inst.fit === null) return
    try {
      inst.fit.fit()
    } catch {
      return
    }
    if (
      inst.term.cols === inst.meta.cols &&
      inst.term.rows === inst.meta.rows
    ) {
      return
    }
    if (inst.resizeTimer !== null) clearTimeout(inst.resizeTimer)
    inst.resizeTimer = setTimeout(() => {
      inst.resizeTimer = null
      this.syncGeometry(inst)
    }, RESIZE_DEBOUNCE_MS)
  }

  /** 最新尺寸胜出、单在飞：响应回来若有更新尺寸再补发一次。 */
  private syncGeometry(inst: TerminalInstance): void {
    if (inst.term === null) return
    const rows = inst.term.rows
    const cols = inst.term.cols
    if (rows === inst.meta.rows && cols === inst.meta.cols) return
    if (inst.resizeInFlight) {
      inst.resizePending = { rows, cols }
      return
    }
    inst.resizeInFlight = true
    resizeTerminal(inst.projectId, inst.meta.terminalId, rows, cols)
      .then(() => {
        inst.meta = { ...inst.meta, rows, cols }
      })
      .catch((error: unknown) => {
        console.debug('[terminal] resize failed', error)
      })
      .finally(() => {
        inst.resizeInFlight = false
        const pending = inst.resizePending
        inst.resizePending = null
        if (pending) this.syncGeometry(inst)
      })
  }

  private applyHostSize(): void {
    if (!this.host) return
    this.host.style.width = `${this.hostSize.width}px`
    this.host.style.height = `${this.hostSize.height}px`
  }

  private ensureHost(): void {
    if (this.host) return
    // 离屏宿主：见 ensureTerm 的 WHY 注释（保布局的隐藏，非 display:none）。
    const host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.position = 'fixed'
    host.style.left = '-99999px'
    host.style.top = '0'
    host.style.visibility = 'hidden'
    host.style.overflow = 'hidden'
    document.body.appendChild(host)
    this.host = host
    this.applyHostSize()
  }
}
