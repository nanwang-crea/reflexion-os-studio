interface GitSourceTabsProps {
  source: 'workspace' | 'agent'
  workspaceCount: number
  agentCount: number
  agentAvailable: boolean
  onChange: (source: 'workspace' | 'agent') => void
}

export function GitSourceTabs(props: GitSourceTabsProps): React.JSX.Element {
  return (
    <div className="git-source-bar">
      <span>变更来源</span>
      <div className="git-source-tabs" role="tablist" aria-label="变更来源">
        <button
          type="button"
          className={props.source === 'workspace' ? 'active' : ''}
          onClick={() => props.onChange('workspace')}
        >
          工作区 {props.workspaceCount}
        </button>
        <button
          type="button"
          className={props.source === 'agent' ? 'active' : ''}
          disabled={!props.agentAvailable}
          onClick={() => props.onChange('agent')}
        >
          当前任务 {props.agentCount}
        </button>
      </div>
    </div>
  )
}
