import { useState } from 'react'

interface ReasoningBlockProps {
  text: string
}

const SUMMARY_MAX_CHARS = 180

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > SUMMARY_MAX_CHARS
    ? `${compact.slice(0, SUMMARY_MAX_CHARS)}…`
    : compact
}

export function ReasoningBlock(props: ReasoningBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`reasoning-block${open ? ' open' : ''}`}>
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-label">思考</span>
        <span className="reasoning-preview">{summarize(props.text)}</span>
      </button>
      {open && <div className="reasoning-full">{props.text}</div>}
    </div>
  )
}
