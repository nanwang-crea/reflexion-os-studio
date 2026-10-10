import type { Ref } from 'react'
import './close-button.css'

export function CloseButton({
  label,
  onClick,
  className = '',
  ref,
}: {
  label: string
  onClick: () => void
  className?: string
  ref?: Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      className={`preview-close ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m6 6 12 12M18 6 6 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
