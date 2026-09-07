import { MonacoEditor } from './editor/MonacoEditor'

interface ContentViewProps {
  projectId: string
  path: string
  initialLine?: number
  onClose: () => void
}

/**
 * Monaco 单文件编辑器：替代原有纯文本行渲染，提供语法高亮、折叠、
 * 搜索、编辑/保存。默认只读，可通过编辑按钮切换。
 */
export function ContentView(props: ContentViewProps): React.JSX.Element {
  return (
    <MonacoEditor
      projectId={props.projectId}
      path={props.path}
      initialLine={props.initialLine}
      readOnly
      onClose={props.onClose}
    />
  )
}
