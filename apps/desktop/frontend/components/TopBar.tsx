import { DoubleChevronIcon, FolderIcon } from '../ui/icons'

/** Runtime 状态文案：顶栏角标与启动页共用。 */
export const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

interface TopBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  contextTitle: string
  /** 仅聊天页显示工作区面板开关。 */
  showWorkspaceToggle: boolean
  workspaceOpen: boolean
  onToggleWorkspace: () => void
  /** A2 Memory：非打断式写入提示角标。 */
  memoryNotice: string | null
  /** 运行时状态；system-ready 时不显示角标。 */
  runtimeState: string
  statusLabel: string
}

/** 主区顶栏：侧栏开关、上下文标题、工作区面板开关与状态角标。 */
export function TopBar(props: TopBarProps): React.JSX.Element {
  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar-toggle"
        title={props.sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
        aria-label={props.sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
        onClick={props.onToggleSidebar}
      >
        <DoubleChevronIcon direction={props.sidebarOpen ? 'left' : 'right'} />
      </button>
      <span className="topbar-title">{props.contextTitle}</span>
      <span className="spacer" />
      {props.showWorkspaceToggle && (
        <button
          type="button"
          className={`topbar-toggle${props.workspaceOpen ? ' active' : ''}`}
          title={props.workspaceOpen ? '收起工作区面板' : '展开工作区面板'}
          aria-label="工作区面板"
          aria-pressed={props.workspaceOpen}
          onClick={props.onToggleWorkspace}
        >
          <FolderIcon />
        </button>
      )}
      {props.memoryNotice && (
        <span className="badge badge-memory">{props.memoryNotice}</span>
      )}
      {props.runtimeState !== 'system-ready' && (
        <span className={`badge badge-${props.runtimeState}`}>
          {props.statusLabel}
        </span>
      )}
    </header>
  )
}
