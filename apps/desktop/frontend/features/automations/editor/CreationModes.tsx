export type WorkflowCreationMode = 'language' | 'canvas'

export function CreationModes({
  value,
  onChange,
}: {
  value: WorkflowCreationMode
  onChange: (value: WorkflowCreationMode) => void
}): React.JSX.Element {
  return (
    <nav className="workflow-creation-modes" aria-label="工作流创建方式">
      <button
        type="button"
        aria-pressed={value === 'language'}
        onClick={() => onChange('language')}
      >
        自然语言创建
      </button>
      <button
        type="button"
        aria-pressed={value === 'canvas'}
        onClick={() => onChange('canvas')}
      >
        画布编辑
      </button>
    </nav>
  )
}
