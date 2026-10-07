import { MonacoEditor } from '../editor/MonacoEditor'
import type { MonacoSurfaceHandle } from '../editor/MonacoSurface'
import type { ConfirmDialogState } from '../../../components/ConfirmDialog'

interface ContentViewProps {
  projectId: string
  path: string
  initialLine?: number
  initialLineNonce?: number
  readOnly?: boolean
  onDirtyChange?: (path: string, dirty: boolean) => void
  confirm?: (state: ConfirmDialogState) => Promise<boolean>
  registerSurface?: (
    path: string,
    getter: (() => MonacoSurfaceHandle | null) | null,
  ) => void
}

/**
 * Monaco 单文件编辑器：替代原有纯文本行渲染，提供语法高亮、折叠、
 * 搜索、编辑/保存，并复用标签栏承载文件身份与关闭操作。
 */
export function ContentView(props: ContentViewProps): React.JSX.Element {
  return (
    <MonacoEditor
      projectId={props.projectId}
      path={props.path}
      initialLine={props.initialLine}
      initialLineNonce={props.initialLineNonce}
      readOnly={props.readOnly ?? true}
      onDirtyChange={props.onDirtyChange}
      registerSurface={props.registerSurface}
      confirm={props.confirm}
    />
  )
}
