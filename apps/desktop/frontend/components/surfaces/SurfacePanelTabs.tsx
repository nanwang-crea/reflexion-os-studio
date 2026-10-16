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
        className="right-surface-collapse"
        aria-label={props.expanded ? '还原分栏' : '放大右侧面板'}
        aria-pressed={props.expanded}
        onClick={props.onToggleExpanded}
      >
        {props.expanded ? '还原' : '放大'}
      </button>
      <button
        type="button"
        aria-label="收起右侧面板"
        onClick={props.onCollapse}
      >
        收起
      </button>
    </nav>
  )
}
