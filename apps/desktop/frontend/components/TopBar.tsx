import { DoubleChevronIcon } from '../ui/icons'
import { TopBarTools } from './TopBarTools'

/** Runtime 状态文案：顶栏角标与启动页共用。 */
export const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

export interface TopBarProps {
  collaborationOpen?: boolean
  onToggleCollaboration?: () => void
  browserOpen: boolean
  onToggleBrowser: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  contextTitle: string
  /** 仅聊天页显示工作区面板开关。 */
  showWorkspaceToggle: boolean
  workspaceOpen: boolean
  onToggleWorkspace: () => void
  /** 仅聊天页显示终端面板开关。 */
  showTerminalToggle: boolean
  terminalOpen: boolean
  onToggleTerminal: () => void
  /** 运行时状态；正常就绪时不显示角标。 */
  runtimeState: string
  statusLabel: string
}

/** 主区顶栏：侧栏开关、标题、面板开关与状态角标。 */
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
      <TopBarTools {...props} />
      {props.runtimeState !== 'runtime-ready' &&
        props.runtimeState !== 'system-ready' && (
          <span className={`badge badge-${props.runtimeState}`}>
            {props.statusLabel}
          </span>
        )}
    </header>
  )
}
