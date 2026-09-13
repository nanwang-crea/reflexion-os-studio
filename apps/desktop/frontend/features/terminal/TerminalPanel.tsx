import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { PANEL_MAX_VH, PANEL_MIN_HEIGHT, terminalManager } from './manager'
import type { TerminalTabView } from './manager'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { PlusIcon, RefreshIcon } from '../../ui/icons'

interface TerminalPanelProps {
  activeProjectId: string | null
  /** 应用级确认弹窗（App 注入，复用共享 ConfirmDialog，不弹系统框）。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}

/**
 * 底部终端面板：只做薄渲染。实例、事件、输入/ack/resize 全在
 * terminalManager（模块级单例，跨页面/跨开合保活）；本组件经
 * useSyncExternalStore 订阅快照，键击不触发 React（AGENTS §11）。
 */
export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const { activeProjectId, confirm } = props
  const getSnapshot = useCallback(
    () => terminalManager.getSnapshot(activeProjectId),
    [activeProjectId],
  )
  const snapshot = useSyncExternalStore(terminalManager.subscribe, getSnapshot)

  const slotRef = useRef<HTMLDivElement | null>(null)
  // 挂载/切标签时把激活容器搬进真实槽位；卸载即回离屏宿主（绝不销毁）。
  useEffect(() => {
    const el = slotRef.current
    if (el === null) return
    terminalManager.attachSlot(el)
    return () => terminalManager.detachSlot(el)
  }, [snapshot.activeId])

  const [firstRunPending, setFirstRunPending] = useState(false)
  const handleCreate = useCallback((): void => {
    if (activeProjectId === null) return
    if (terminalManager.needsFirstRunNotice()) {
      setFirstRunPending(true)
      return
    }
    void terminalManager.createTab(activeProjectId)
  }, [activeProjectId])

  const handleFirstRunContinue = useCallback((): void => {
    setFirstRunPending(false)
    terminalManager.dismissFirstRunNotice()
    if (activeProjectId !== null)
      void terminalManager.createTab(activeProjectId)
  }, [activeProjectId])

  const handleCloseTab = useCallback(
    async (tab: TerminalTabView): Promise<void> => {
      if (activeProjectId === null) return
      const ok = await confirm({
        title: '关闭终端',
        message: '关闭终端将终止 shell 及其子进程。',
        confirmLabel: '关闭',
        danger: true,
      })
      if (ok) void terminalManager.closeTab(activeProjectId, tab.terminalId)
    },
    [activeProjectId, confirm],
  )

  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const maxDragHeight = () =>
    Math.max(PANEL_MIN_HEIGHT, Math.floor(window.innerHeight * PANEL_MAX_VH))

  return (
    <div className="terminal-panel" style={{ height: snapshot.heightPx }}>
      <div
        className={`terminal-resize-handle${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        title="拖动调整终端面板高度"
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = {
            startY: event.clientY,
            startHeight: snapshot.heightPx,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag === null) return
          terminalManager.setPanelHeight(
            Math.min(
              maxDragHeight(),
              Math.max(
                PANEL_MIN_HEIGHT,
                drag.startHeight - (event.clientY - drag.startY),
              ),
            ),
          )
        }}
        onPointerUp={(event) => {
          dragRef.current = null
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => {
          dragRef.current = null
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      />
      <div className="terminal-tabstrip">
        <div className="terminal-tabs">
          {snapshot.tabs.map((tab) => {
            const active = tab.terminalId === snapshot.activeId
            const dead =
              tab.status === 'exited' ||
              tab.status === 'failed' ||
              tab.status === 'disconnected' ||
              tab.status === 'closed'
            return (
              <div
                key={tab.terminalId}
                className={`terminal-tab${active ? ' active' : ''}${
                  tab.status === 'closing' || dead ? ' dim' : ''
                }`}
                title={statusTitle(tab)}
              >
                <button
                  type="button"
                  className="terminal-tab-main"
                  onClick={() => {
                    if (activeProjectId !== null)
                      terminalManager.selectTab(activeProjectId, tab.terminalId)
                  }}
                >
                  <span
                    className={`terminal-status-dot ${tab.status}`}
                    aria-hidden="true"
                  />
                  <span className="terminal-tab-label">{tab.label}</span>
                  {tab.expired && <span className="terminal-chip">已失效</span>}
                  {tab.status === 'disconnected' && !tab.expired && (
                    <span className="terminal-chip">已断开</span>
                  )}
                  {tab.status === 'exited' && tab.exitCode !== undefined && (
                    <span className="terminal-exit-code">
                      {tab.exitCode === null ? 'signal' : tab.exitCode}
                    </span>
                  )}
                </button>
                {dead && activeProjectId !== null && (
                  <button
                    type="button"
                    className="terminal-tab-close"
                    title="重新创建终端"
                    aria-label="重新创建终端"
                    onClick={() =>
                      void terminalManager.recreateTab(
                        activeProjectId,
                        tab.terminalId,
                      )
                    }
                  >
                    <RefreshIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="terminal-tab-close"
                  title="关闭终端标签"
                  aria-label="关闭终端标签"
                  onClick={() => void handleCloseTab(tab)}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className="terminal-new-tab"
          title={activeProjectId === null ? '请先打开项目' : '新建终端标签'}
          aria-label="新建终端标签"
          disabled={activeProjectId === null || firstRunPending}
          onClick={handleCreate}
        >
          <PlusIcon size={15} />
        </button>
      </div>
      {firstRunPending && (
        <div className="terminal-notice" role="alert">
          <span>
            终端使用当前用户权限运行。项目目录只是起始目录，不限制访问其他文件。
          </span>
          <button type="button" onClick={handleFirstRunContinue}>
            继续
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setFirstRunPending(false)}
          >
            取消
          </button>
        </div>
      )}
      <div className="terminal-body">
        <div className="terminal-slot" ref={slotRef} />
        {snapshot.tabs.length === 0 && (
          <div className="terminal-empty">
            {activeProjectId === null
              ? '打开项目后可在这里使用集成终端。'
              : '暂无终端，点击左上角 ＋ 新建。'}
          </div>
        )}
      </div>
    </div>
  )
}

function statusTitle(tab: TerminalTabView): string {
  if (tab.expired) return '终端已失效'
  switch (tab.status) {
    case 'running':
      return '运行中'
    case 'starting':
      return '正在启动'
    case 'closing':
      return '正在关闭'
    case 'exited':
      return tab.exitCode === null
        ? '已被信号终止'
        : `已退出（退出码 ${tab.exitCode ?? '未知'}）`
    case 'disconnected':
      return '已断开：系统 Runtime 重启，可重新创建'
    case 'failed':
      // 失败原因来自 terminal.state 可选字段，可能缺省。
      return tab.errorMessage
        ? `启动失败，可重新创建：${tab.errorMessage}`
        : '启动失败，可重新创建'
    default:
      return '已关闭'
  }
}
