import { useState, useEffect } from 'react'

/** Text remains editable while invalid; apply is an explicit action. Key by selected document. */
export function JsonField({
  label,
  value,
  onApply,
}: {
  label: string
  value: unknown
  onApply: (value: unknown) => void | Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const current = JSON.stringify(value, null, 2)
  const [base, setBase] = useState(current)
  const [edited, setEdited] = useState(false)
  const [applying, setApplying] = useState(false)
  useEffect(() => {
    if (!edited) {
      setText(current)
      setBase(current)
    }
  }, [current, edited])
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="workflow-json-field">
      <label>
        {label}
        <textarea
          rows={8}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setEdited(true)
          }}
          spellCheck={false}
          disabled={applying}
        />
      </label>
      <button
        type="button"
        disabled={applying}
        onClick={async () => {
          setApplying(true)
          try {
            if (current !== base)
              throw new Error('配置已有新编辑，请刷新此 JSON 后合并，避免覆盖')
            await onApply(JSON.parse(text))
            setEdited(false)
            setError(null)
          } catch (error) {
            setError(error instanceof Error ? error.message : 'JSON 无效')
          } finally {
            setApplying(false)
          }
        }}
      >
        应用 {label}
      </button>
      {edited && (
        <>
          <small>JSON 编辑尚未应用到草稿。</small>
          <button
            type="button"
            disabled={applying}
            onClick={() => {
              setText(current)
              setBase(current)
              setEdited(false)
              setError(null)
            }}
          >
            放弃 JSON 编辑，刷新配置
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
