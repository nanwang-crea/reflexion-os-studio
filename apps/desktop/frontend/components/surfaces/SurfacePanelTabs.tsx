import './surface-panel-tabs.css'

type Surface = 'workspace' | 'browser' | 'collaboration'

/** Shared navigation and sizing controls for the right-hand surfaces. */
export function SurfacePanelTabs(props: {
  active: Surface
  showWorkspace: boolean
  showCollaboration: boolean
  expanded: boolean
  onSelect: (surface: Surface) => void
  onToggleExpanded: () => void
  onCollapse: () => void
}): React.JSX.Element {
  return (
    <nav className="right-surface-tabs" aria-label="右侧面板">
      {(
        [
          ['workspace', '工作区', props.showWorkspace],
          ['browser', '浏览器', true],
          ['collaboration', '协作', props.showCollaboration],
        ] as const
      ).map(([surface, label, visible]) =>
        visible ? (
          <button
            key={surface}
            type="button"
            aria-pressed={props.active === surface}
            onClick={() => props.onSelect(surface)}
          >
            {label}
          </button>
        ) : null,
      )}
      <button
        type="button"
        className="right-surface-action right-surface-expand"
        title={props.expanded ? '还原分栏' : '放大右侧面板'}
        aria-label={props.expanded ? '还原分栏' : '放大右侧面板'}
        aria-pressed={props.expanded}
        onClick={props.onToggleExpanded}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path
            d={
              props.expanded
                ? 'M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6'
                : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'
            }
          />
        </svg>
      </button>
      <button
        type="button"
        className="right-surface-action"
        title="收起右侧面板"
        aria-label="收起右侧面板"
        onClick={props.onCollapse}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16m-6-11 3 3-3 3" />
        </svg>
      </button>
    </nav>
  )
}
