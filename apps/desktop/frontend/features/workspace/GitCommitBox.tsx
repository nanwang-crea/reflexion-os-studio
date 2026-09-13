import { IS_MAC } from '../../lib/platform'

interface GitCommitBoxProps {
  message: string
  canCommit: boolean
  busy: boolean
  onMessage: (value: string) => void
  onCommit: (andPush: boolean) => void
}

/** 提交信息输入区：textarea + 提交/提交并推送，⌘/Ctrl+Enter 提交。 */
export function GitCommitBox(props: GitCommitBoxProps): React.JSX.Element {
  return (
    <div className="git-commit-box">
      <textarea
        className="git-commit-input"
        placeholder={`提交信息（${IS_MAC ? '⌘' : 'Ctrl'}+Enter 提交）`}
        value={props.message}
        disabled={props.busy}
        onChange={(event) => props.onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (
            (IS_MAC ? event.metaKey : event.ctrlKey) &&
            event.key === 'Enter'
          ) {
            event.preventDefault()
            props.onCommit(false)
          }
        }}
      />
      <div className="git-commit-actions">
        <button
          disabled={!props.canCommit || props.busy}
          onClick={() => props.onCommit(false)}
        >
          提交
        </button>
        <button
          disabled={!props.canCommit || props.busy}
          onClick={() => props.onCommit(true)}
        >
          提交并推送
        </button>
      </div>
    </div>
  )
}
