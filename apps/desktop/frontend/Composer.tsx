import { useRef, useState } from 'react'
import { ChevronIcon, SendIcon, ShieldIcon, StopIcon } from './ui/icons'

export interface ComposerModelOption {
  /** `${providerId}::${model}` */
  key: string
  label: string
  group: string
}

interface ComposerProps {
  placeholder: string
  disabled?: boolean
  /** 有 Run 进行中时为 true：显示停止按钮并阻止提交。 */
  busy?: boolean
  autoFocus?: boolean
  /** 权限 Profile（workspace / read-only），随工具能力上线生效。 */
  permissionValue?: string
  onPermissionChange?: (value: string) => void
  modelOptions?: ComposerModelOption[]
  selectedModelKey?: string | null
  onModelChange?: (key: string) => void
  onSend: (content: string) => Promise<void> | void
  onStop?: () => Promise<void> | void
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = props.busy ?? false
  const showModelSelect =
    props.modelOptions !== undefined &&
    props.modelOptions.length > 0 &&
    props.onModelChange !== undefined

  const submit = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || props.disabled || busy || sending) return
    setDraft('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setSending(true)
    try {
      await props.onSend(content)
    } finally {
      setSending(false)
    }
  }

  const groups: { group: string; options: ComposerModelOption[] }[] = []
  for (const option of props.modelOptions ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.group === option.group) {
      last.options.push(option)
    } else {
      groups.push({ group: option.group, options: [option] })
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          const element = event.target
          element.style.height = 'auto'
          element.style.height = `${Math.min(element.scrollHeight, 200)}px`
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        {props.permissionValue !== undefined && props.onPermissionChange && (
          <label
            className="composer-select permission"
            title="工具权限模式（随工具能力上线生效）"
          >
            <ShieldIcon />
            <select
              value={props.permissionValue}
              onChange={(event) =>
                props.onPermissionChange?.(event.target.value)
              }
            >
              <option value="workspace">工作区读写</option>
              <option value="read-only">只读</option>
            </select>
            <ChevronIcon />
          </label>
        )}
        <span className="bar-spacer" />
        {showModelSelect && (
          <label className="composer-select model" title="对话使用的模型">
            <select
              value={props.selectedModelKey ?? ''}
              onChange={(event) => props.onModelChange?.(event.target.value)}
            >
              {groups.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronIcon />
          </label>
        )}
        {props.modelOptions !== undefined &&
          props.modelOptions.length === 0 && (
            <span className="composer-no-model">未配置模型</span>
          )}
        {busy && props.onStop ? (
          <button
            className="composer-stop"
            aria-label="停止"
            title="停止当前回复"
            onClick={() => void props.onStop?.()}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="composer-send"
            aria-label="发送"
            title="发送"
            disabled={props.disabled || !draft.trim() || sending}
            onClick={() => void submit()}
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
