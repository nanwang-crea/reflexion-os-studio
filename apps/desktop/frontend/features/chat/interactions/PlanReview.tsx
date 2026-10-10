import { useEffect, useRef, useState } from 'react'
import type {
  PlanSnapshot,
  ResourceLink,
} from '@reflexion-os-studio/runtime-client'
import { workspaceFileUri } from '@reflexion-os-studio/runtime-client'
import { MarkdownCore } from '../../../components/markdown/md-core'
import { ReadOnlyDialog } from '../../../components/dialogs/ReadOnlyDialog'
import './plan-review.css'

/** 正文独立审阅；审批卡只提供入口。历史快照不依赖已清理的文件。 */
export function PlanReview(props: {
  snapshot: PlanSnapshot
  historical?: boolean
  onResourceClick?: (link: ResourceLink) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const latest = useRef(props)
  latest.current = props
  const { planId, sha256 } = props.snapshot
  useEffect(() => {
    const { snapshot, historical, onResourceClick } = latest.current
    if (!historical && snapshot.path && snapshot.projectId && onResourceClick) {
      onResourceClick({
        kind: 'workspaceFile',
        uri: workspaceFileUri(snapshot.projectId, snapshot.path),
        projectId: snapshot.projectId,
        path: snapshot.path,
      })
    }
  }, [planId, sha256])
  const openFile = (): void => {
    const { snapshot, onResourceClick } = props
    if (snapshot.path && snapshot.projectId && onResourceClick) {
      onResourceClick({
        kind: 'workspaceFile',
        uri: workspaceFileUri(snapshot.projectId, snapshot.path),
        projectId: snapshot.projectId,
        path: snapshot.path,
      })
    } else setOpen(true)
  }
  return (
    <div className="plan-review-entry">
      {!props.historical && (
        <button type="button" className="ghost" onClick={openFile}>
          查看 / 编辑计划
        </button>
      )}
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        {props.historical ? '查看审批时的计划' : '查看本次审批版本'}
      </button>
      {!props.historical && props.snapshot.path && (
        <small>{props.snapshot.path}</small>
      )}
      {open && (
        <ReadOnlyDialog
          label="计划审阅"
          title={<strong>{props.snapshot.goal}</strong>}
          onClose={() => setOpen(false)}
        >
          <div className="plan-review-content">
            <p>审批时保存的计划 · 此版本只读</p>
            <MarkdownCore
              text={props.snapshot.markdown}
              onResourceClick={props.onResourceClick}
            />
          </div>
        </ReadOnlyDialog>
      )}
    </div>
  )
}
