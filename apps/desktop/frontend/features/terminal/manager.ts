import {
  closeTerminal,
  createTerminal,
  listTerminals,
} from '../../api/terminal'
import type { TerminalStatus } from '@reflexion-os-studio/runtime-client'
import { showToast } from '../../components/Toast'
import {
  isTerminalEntryDisabled,
  TERMINAL_DISABLED_NOTICE,
} from './entry-switch'
import { TerminalRuntime } from './runtime'
import { DEAD_STATUSES } from './types'
import type { TerminalInstance, TerminalMeta } from './types'
import { extractErrorCode, notifyTerminalError } from './notices'

/**
 * 应用级终端管理器（W3）：模块级单例，**不进 React 状态**。
 * 本文件管"标签页"——项目归属、显示顺序、激活、开合/高度偏好与
 * React 快照（useSyncExternalStore）；"终端"本身的 xterm/事件/输入/
 * ack/resize 在 runtime.ts。AGENTS §11：订阅一次接线、键击零 React。
 */

export interface TerminalTabView {
  terminalId: string
  label: string
  status: TerminalStatus
  exitCode: number | null | undefined
  /** attach 竞态失效标记（M-1）：标题显示「终端已失效」。 */
  expired: boolean
  /** terminal.state 携带的失败原因（M-2；仅 failed 态有展示意义，可缺省）。 */
  errorMessage?: string
}

export interface TerminalSnapshot {
  tabs: TerminalTabView[]
  activeId: string | null
  panelOpen: boolean
  heightPx: number
}

const PREF_OPEN = 'terminal.panel.open'
const PREF_HEIGHT = 'terminal.panel.height'
const PREF_FIRST_RUN = 'terminal.firstRunNoticed'
export const PANEL_MIN_HEIGHT = 120
export const PANEL_MAX_VH = 0.6
const DEFAULT_HEIGHT = 300

class TerminalManager {
  private readonly runtime: TerminalRuntime
  private readonly tabsByProject = new Map<string, string[]>()
  private readonly activeByProject = new Map<string, string | null>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache = new Map<string, TerminalSnapshot>()
  private readonly rehydrateSeq = new Map<string, number>()
  private initialized = false
  private activeProjectId: string | null = null
  // 入口被禁用（发布开关/逃生舱）时面板不得以"开"态启动：顶栏按钮已
  // 隐藏，开着的无标签空面板将无法收起。
  private panelOpen: boolean =
    !isTerminalEntryDisabled() && localStorage.getItem(PREF_OPEN) !== '0'
  private heightPx: number = clampHeight(
    Number(localStorage.getItem(PREF_HEIGHT)) || DEFAULT_HEIGHT,
  )

  constructor() {
    this.runtime = new TerminalRuntime({
      notify: () => this.notify(),
      getVisible: () => {
        if (!this.panelOpen || this.activeProjectId === null) return null
        const activeId = this.activeByProject.get(this.activeProjectId)
        return typeof activeId === 'string'
          ? { projectId: this.activeProjectId, terminalId: activeId }
          : null
      },
    })
  }

  // ---------------- React 桥（身份稳定的入口） ----------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  selectPanelOpen = (): boolean => this.panelOpen

  getSnapshot = (projectId: string | null): TerminalSnapshot => {
    const key = projectId ?? '__none__'
    const cached = this.snapshotCache.get(key)
    if (cached) return cached
    const tabs = (this.tabsByProject.get(key) ?? []).flatMap((id) => {
      const inst = this.runtime.get(id)
      return inst ? [this.tabView(inst)] : []
    })
    const labels = this.disambiguateLabels(tabs)
    const snapshot: TerminalSnapshot = {
      tabs: tabs.map((tab, index) => ({ ...tab, label: labels[index] })),
      activeId: this.activeByProject.get(key) ?? null,
      panelOpen: this.panelOpen,
      heightPx: this.heightPx,
    }
    this.snapshotCache.set(key, snapshot)
    return snapshot
  }

  /** 幂等初始化（App 根 effect 调用一次）：接线 transport 单订阅。 */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    this.runtime.init()
  }

  // ---------------- 项目与标签 ----------------

  setActiveProject(projectId: string | null): void {
    if (this.activeProjectId === projectId) return
    this.activeProjectId = projectId
    this.notify()
    // 先重排容器：上一个项目的激活终端必须立刻离屏（不得在切项目后闪现）。
    this.runtime.render()
    if (projectId !== null) void this.rehydrate(projectId)
  }

  /**
   * 重挂项目标签：list 含已退出/断开的留存记录 → 如实展示。
   * running/starting 终端立即 attach（与面板可见性无关）——后端 10s
   * attach 超时会把未 attach 的 running 终端判为僵尸直接关闭，等面板
   * 打开再 attach 会输掉这个窗口；xterm 则严格延迟到首次展示。
   * spec 决策注释：attach 提前、渲染延后，两者解耦。
   */
  private async rehydrate(projectId: string): Promise<void> {
    const ticket = (this.rehydrateSeq.get(projectId) ?? 0) + 1
    this.rehydrateSeq.set(projectId, ticket)
    let terminals: TerminalMeta[]
    try {
      terminals = (await listTerminals(projectId)).terminals
    } catch (error) {
      console.debug('[terminal] list failed', error)
      return
    }
    if (this.rehydrateSeq.get(projectId) !== ticket) return
    const tabs: string[] = []
    for (const meta of terminals) {
      if (meta.status === 'closed') continue // 已被清理的标签不再招魂
      tabs.push(meta.terminalId)
      const existing = this.runtime.get(meta.terminalId)
      if (existing) {
        existing.meta = meta
        existing.expired = false // list 中仍可见 = 后端还在跟踪，撤销失效猜测
      } else {
        const inst = this.runtime.register(meta)
        if (!DEAD_STATUSES.has(meta.status)) void this.runtime.attach(inst)
      }
    }
    // 本地有、list 无的终端：两种可能——刚创建还没进本次快照（create 与
    // list 竞态），或已被后端回收。存活的一律保留标签，已死的剔除。
    for (const id of this.tabsByProject.get(projectId) ?? []) {
      if (tabs.includes(id)) continue
      const inst = this.runtime.get(id)
      if (inst && !DEAD_STATUSES.has(inst.meta.status)) tabs.push(id)
      else if (inst) this.runtime.disposeInstance(id)
    }
    this.tabsByProject.set(projectId, tabs)
    const active = this.activeByProject.get(projectId)
    this.activeByProject.set(
      projectId,
      typeof active === 'string' && tabs.includes(active)
        ? active
        : (tabs[0] ?? null),
    )
    this.notify()
    this.materializeVisible()
    this.runtime.render()
  }

  async createTab(projectId: string): Promise<void> {
    // 入口开关（spec §10）：禁用即拒绝新建；已打开的终端不动——
    // 静默杀 shell 会丢用户数据，统一关闭是发布回滚流程的事。
    if (isTerminalEntryDisabled()) {
      showToast(TERMINAL_DISABLED_NOTICE, 'error')
      return
    }
    const geometry = this.preferredGeometry(projectId)
    let meta: TerminalMeta
    try {
      meta = (await createTerminal(projectId, geometry.rows, geometry.cols))
        .terminal
    } catch (error) {
      notifyTerminalError(error, '创建终端失败')
      return
    }
    const inst = this.runtime.register(meta)
    this.tabsOf(projectId).push(meta.terminalId)
    this.activeByProject.set(projectId, meta.terminalId)
    this.notify()
    // 新建即展示：xterm 同步落位；attach 紧随（10s 僵尸超时的安全边界）。
    this.runtime.ensureTerm(inst)
    await this.runtime.attach(inst)
    this.runtime.render()
    inst.term?.focus()
  }

  selectTab(projectId: string, terminalId: string): void {
    if (this.activeByProject.get(projectId) === terminalId) return
    this.activeByProject.set(projectId, terminalId)
    const inst = this.runtime.get(terminalId)
    if (inst) this.runtime.ensureTerm(inst) // 首次展示才建 xterm
    this.notify()
    if (inst) {
      this.runtime.render()
      inst.term?.focus()
    }
  }

  /** 项目内未到终态（starting/running/closing）的终端数：删除项目确认文案用。 */
  activeCount(projectId: string): number {
    return this.tabsOf(projectId).filter((id) => {
      const inst = this.runtime.get(id)
      return inst !== undefined && !DEAD_STATUSES.has(inst.meta.status)
    }).length
  }

  async closeTab(projectId: string, terminalId: string): Promise<void> {
    const inst = this.runtime.get(terminalId)
    if (inst) inst.closing = true
    this.notify()
    try {
      await closeTerminal(projectId, terminalId)
    } catch (error) {
      // terminal_not_found：后端已回收，本地照常摘标签，不算错误。
      if (extractErrorCode(error) === 'terminal_not_found') {
        this.removeTab(projectId, terminalId)
        return
      }
      notifyTerminalError(error, '关闭终端失败')
      if (inst) inst.closing = false
      this.notify()
      return
    }
    this.removeTab(projectId, terminalId)
  }

  /** exited/failed/disconnected 标签的「重新创建」：新终端原位替换，旧 id 幂等关闭。 */
  async recreateTab(projectId: string, deadTerminalId: string): Promise<void> {
    // recreate 同样 spawn 新终端，属"新建"入口，禁用时一并拒绝。
    if (isTerminalEntryDisabled()) {
      showToast(TERMINAL_DISABLED_NOTICE, 'error')
      return
    }
    const geometry = this.preferredGeometry(projectId)
    let meta: TerminalMeta
    try {
      meta = (await createTerminal(projectId, geometry.rows, geometry.cols))
        .terminal
    } catch (error) {
      notifyTerminalError(error, '重建终端失败')
      return
    }
    const tabs = this.tabsOf(projectId)
    const index = tabs.indexOf(deadTerminalId)
    this.runtime.register(meta)
    if (index >= 0) tabs.splice(index, 1, meta.terminalId)
    else tabs.push(meta.terminalId)
    if (this.activeByProject.get(projectId) === deadTerminalId) {
      this.activeByProject.set(projectId, meta.terminalId)
    }
    this.runtime.disposeInstance(deadTerminalId)
    void closeTerminal(projectId, deadTerminalId).catch(() => undefined)
    this.notify()
    const inst = this.runtime.get(meta.terminalId)
    if (inst) {
      this.runtime.ensureTerm(inst)
      await this.runtime.attach(inst)
      this.runtime.render()
    }
  }

  // ---------------- 面板槽位（TerminalPanel 挂载/卸载接线） ----------------

  attachSlot(el: HTMLElement | null): void {
    if (el !== null) this.materializeVisible()
    this.runtime.attachSlot(el)
  }

  detachSlot(el: HTMLElement): void {
    this.runtime.detachSlot(el)
  }

  // ---------------- 开合与偏好（UI-only，spec §9） ----------------

  setPanelOpen(open: boolean): void {
    if (this.panelOpen === open) return
    this.panelOpen = open
    localStorage.setItem(PREF_OPEN, open ? '1' : '0')
    this.notify()
    if (open) this.materializeVisible()
    this.runtime.render()
  }

  togglePanel(): void {
    this.setPanelOpen(!this.panelOpen)
  }

  setPanelHeight(px: number): void {
    const next = clampHeight(px)
    if (this.heightPx === next) return
    this.heightPx = next
    localStorage.setItem(PREF_HEIGHT, String(next))
    this.notify()
  }

  needsFirstRunNotice(): boolean {
    return localStorage.getItem(PREF_FIRST_RUN) !== '1'
  }

  dismissFirstRunNotice(): void {
    localStorage.setItem(PREF_FIRST_RUN, '1')
    this.notify()
  }

  // ---------------- 内部 ----------------

  private removeTab(projectId: string, terminalId: string): void {
    const tabs = this.tabsOf(projectId)
    const index = tabs.indexOf(terminalId)
    if (index >= 0) tabs.splice(index, 1)
    if (this.activeByProject.get(projectId) === terminalId) {
      const neighbor = tabs[Math.min(index, tabs.length - 1)] ?? null
      this.activeByProject.set(projectId, neighbor)
    }
    this.runtime.disposeInstance(terminalId)
    this.notify()
    this.materializeVisible() // 邻接标签成为激活项：其 xterm 若未建，立即补建
    this.runtime.render()
  }

  /** 面板挂载/打开/重挂后：激活标签的 xterm 到首次展示时才创建（懒建）。 */
  private materializeVisible(): void {
    if (!this.panelOpen || this.activeProjectId === null) return
    const activeId = this.activeByProject.get(this.activeProjectId)
    if (typeof activeId !== 'string') return
    const inst = this.runtime.get(activeId)
    if (inst) this.runtime.ensureTerm(inst)
  }

  private tabsOf(projectId: string): string[] {
    let tabs = this.tabsByProject.get(projectId)
    if (!tabs) {
      tabs = []
      this.tabsByProject.set(projectId, tabs)
    }
    return tabs
  }

  private preferredGeometry(projectId: string): { rows: number; cols: number } {
    const activeId = this.activeByProject.get(projectId)
    const inst: TerminalInstance | undefined = activeId
      ? this.runtime.get(activeId)
      : undefined
    if (inst?.term) return { rows: inst.term.rows, cols: inst.term.cols }
    return { rows: 24, cols: 80 }
  }

  private tabView(inst: TerminalInstance): TerminalTabView {
    return {
      terminalId: inst.meta.terminalId,
      label: shellNameOf(inst.meta),
      status: inst.closing ? 'closing' : inst.meta.status,
      exitCode: inst.meta.exitCode,
      expired: inst.expired,
      ...(inst.meta.errorMessage !== undefined
        ? { errorMessage: inst.meta.errorMessage }
        : {}),
    }
  }

  /** 同名 shell 加序号消歧：shell / shell 2（后端暂未回传 shellArgv）。 */
  private disambiguateLabels(tabs: TerminalTabView[]): string[] {
    const seen = new Map<string, number>()
    return tabs.map((tab) => {
      const count = (seen.get(tab.label) ?? 0) + 1
      seen.set(tab.label, count)
      return count === 1 ? tab.label : `${tab.label} ${count}`
    })
  }

  private notify(): void {
    this.snapshotCache.clear()
    for (const listener of this.listeners) listener()
  }
}

function clampHeight(px: number): number {
  const max = Math.max(
    PANEL_MIN_HEIGHT,
    Math.floor(window.innerHeight * PANEL_MAX_VH),
  )
  return Math.max(PANEL_MIN_HEIGHT, Math.min(max, Math.round(px)))
}

/** shell 展示名：优先后端 argv 的 basename（去 .exe）；当前后端回传为空则 "shell"。 */
function shellNameOf(meta: TerminalMeta): string {
  const argv0 = meta.shellArgv[0]
  if (!argv0) return 'shell'
  const parts = argv0.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? 'shell'
  return base.replace(/\.exe$/i, '') || 'shell'
}

export const terminalManager = new TerminalManager()
