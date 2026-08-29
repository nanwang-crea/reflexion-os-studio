import { useRef, useState } from 'react'

interface ComposerProps {
  placeholder: string
  disabled?: boolean
  /** 有 Run 进行中时为 true：显示停止按钮并阻止提交。 */
  busy?: boolean
  onSend: (content: string) => Promise<void> | void
  onStop?: () => Promise<void> | void
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const busy = props.busy ?? false

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

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        rows={1}
        placeholder={props.placeholder}
        disabled={props.disabled}
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
      {busy && props.onStop ? (
        <button
          className="composer-stop"
          aria-label="停止"
          title="停止当前回复"
          onClick={() => void props.onStop?.()}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect
              x="6"
              y="6"
              width="12"
              height="12"
              rx="2"
              fill="currentColor"
            />
          </svg>
        </button>
      ) : (
        <button
          className="composer-send"
          aria-label="发送"
          title="发送"
          disabled={props.disabled || !draft.trim() || sending}
          onClick={() => void submit()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M12 19V5M5 12l7-7 7 7"
              stroke="currentColor"
              strokeWidth="2.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
