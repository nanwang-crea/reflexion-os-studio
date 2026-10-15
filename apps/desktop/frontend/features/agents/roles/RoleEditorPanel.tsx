import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { RoleSidePanel } from './RoleSidePanel'
import { RoleEditor } from './RoleEditor'

type Props = ComponentProps<typeof RoleEditor> & { error: string | null }

export function RoleEditorPanel(props: Props): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const original = useRef(JSON.stringify(props.value))
  const [discard, setDiscard] = useState(false)
  const keepEditing = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (discard) keepEditing.current?.focus()
  }, [discard])
  const close = () => {
    if (props.busy) return
    if (JSON.stringify(props.value) !== original.current) {
      setDiscard(true)
      body.current?.scrollTo({ top: 0 })
    } else props.onCancel()
  }
  return (
    <RoleSidePanel
      title={props.value.id ? '编辑角色' : '新建角色'}
      busy={props.busy}
      onClose={close}
      bodyRef={body}
    >
      {props.error && (
        <p role="alert" className="error">
          {props.error}
        </p>
      )}
      {discard && (
        <div className="agent-role-discard" role="alert">
          <p>有尚未保存的修改，是否放弃？</p>
          <button
            ref={keepEditing}
            type="button"
            onClick={() => setDiscard(false)}
          >
            继续编辑
          </button>
          <button type="button" onClick={props.onCancel}>
            放弃修改
          </button>
        </div>
      )}
      <RoleEditor {...props} onCancel={close} />
    </RoleSidePanel>
  )
}
