import type { ComponentProps } from 'react'
import { AppMain } from '../AppMain'
import { DangerConfirmationDialog } from '../features/chat/approvals/DangerConfirmationDialog'
import { ConfirmDialog, type ConfirmDialogState } from './ConfirmDialog'
import { ResizeHandle } from './ResizeHandle'
import { Sidebar } from './Sidebar'
import { ToastHost } from './Toast'

export interface AppShellProps {
  sidebar: Omit<ComponentProps<typeof Sidebar>, 'width'>
  sidebarWidth: number
  setSidebarWidth: (updater: (width: number) => number) => void
  main: ComponentProps<typeof AppMain>
  danger: {
    open: boolean
    sessionId: string | null
    onClose: () => void
    onEnabled: () => void
  }
  confirm: {
    state: ConfirmDialogState | null
    onConfirm: () => void
    onCancel: () => void
    onTertiary: () => void
  }
}

/** 运行时就绪后的主壳：侧栏、主区、确认与危险授权弹层。 */
export function AppShell(props: AppShellProps): React.JSX.Element {
  return (
    <div className="app-shell">
      <Sidebar {...props.sidebar} width={props.sidebarWidth} />
      <ResizeHandle
        onResize={(delta) =>
          props.setSidebarWidth((width) =>
            Math.max(200, Math.min(560, width + delta)),
          )
        }
      />
      <AppMain {...props.main} />
      <DangerConfirmationDialog
        open={props.danger.open}
        sessionId={props.danger.sessionId}
        onClose={props.danger.onClose}
        onEnabled={props.danger.onEnabled}
      />
      <ConfirmDialog
        state={props.confirm.state}
        onConfirm={props.confirm.onConfirm}
        onCancel={props.confirm.onCancel}
        onTertiary={props.confirm.onTertiary}
      />
      <ToastHost />
    </div>
  )
}
