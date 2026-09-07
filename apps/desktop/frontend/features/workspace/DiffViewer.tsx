import { MonacoDiffEditor } from './editor/MonacoDiffEditor'

interface DiffViewerProps {
  projectId: string
  path: string
  staged?: boolean
  oldPath?: string
  source?: 'git' | 'chat'
  before?: string
  after?: string
  onClose: () => void
}

/**
 * Monaco DiffEditor：替代原有自研对齐渲染，提供语法高亮、差异导航、
 * 折叠。只读，不可编辑。
 */
export function DiffViewer(props: DiffViewerProps): React.JSX.Element {
  return (
    <MonacoDiffEditor
      projectId={props.projectId}
      path={props.path}
      staged={props.staged}
      oldPath={props.oldPath}
      source={props.source}
      before={props.before}
      after={props.after}
      onClose={props.onClose}
    />
  )
}
