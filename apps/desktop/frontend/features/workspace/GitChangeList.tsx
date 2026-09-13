import type { GitChangeEntry } from '@reflexion-os-studio/runtime-client'
import { RefreshIcon } from '../../ui/icons'

interface GitChangeListProps {
  entries: GitChangeEntry[]
  truncated: boolean
  busy: boolean
  /** 忙态文案（如“提交中”），显示在头部计数后；空闲为 null。 */
  busyLabel: string | null
  onOpen: (entry: GitChangeEntry) => void
  onStagePaths: (paths: string[]) => void
  onUnstagePaths: (paths: string[]) => void
  onRefresh: () => void
}

/** 变更状态 → 中文徽章文案；Git 变更与提交历史两个面板共用。 */
export const STATUS_LABELS: Record<GitChangeEntry['status'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
}

/** 变更列表区：头部批量操作 + 已暂存/变更分组 + 行内 +/- 暂存操作。 */
export function GitChangeList(props: GitChangeListProps): React.JSX.Element {
  const staged = props.entries.filter((entry) => entry.staged)
  const unstaged = props.entries.filter((entry) => !entry.staged)
  const conflicts = unstaged.filter(
    (entry) => entry.status === 'conflicted',
  ).length
  // unstage 重命名条目必须同时枚举新旧两路径，否则只解掉新增一半、
  // 删除一半留在暂存区（git reset 按 pathspec 精确匹配）。
  const unstagePathsOf = (entry: GitChangeEntry): string[] =>
    entry.status === 'renamed' && entry.oldPath !== undefined
      ? [entry.oldPath, entry.path]
      : [entry.path]
  const stagedPaths = staged.flatMap(unstagePathsOf)
  const unstagedPaths = unstaged
    .filter((entry) => entry.status !== 'conflicted')
    .map((entry) => entry.path)

  const renderGroup = (
    label: string,
    rows: GitChangeEntry[],
    mode: 'staged' | 'unstaged',
  ): React.JSX.Element => (
    <section>
      <div className="git-group-label">
        {label}（{rows.length}
        {mode === 'unstaged' && conflicts > 0 ? `，${conflicts} 冲突` : ''}）
      </div>
      <ul className="git-list">
        {rows.map((entry) => (
          <li key={entry.path} className="git-list-item">
            <button
              type="button"
              className="git-row"
              onClick={() => props.onOpen(entry)}
              title={`在右侧打开 ${entry.path}`}
            >
              <span className={`git-badge git-badge-${entry.status}`}>
                {STATUS_LABELS[entry.status]}
              </span>
              <span className="git-path">{entry.path}</span>
              {entry.oldPath !== undefined && (
                <span className="git-old-path">{entry.oldPath} →</span>
              )}
            </button>
            {entry.status !== 'conflicted' && (
              <button
                type="button"
                className="git-row-action"
                disabled={props.busy}
                title={mode === 'staged' ? '取消暂存' : '暂存'}
                aria-label={mode === 'staged' ? '取消暂存' : '暂存'}
                onClick={() =>
                  mode === 'staged'
                    ? props.onUnstagePaths(unstagePathsOf(entry))
                    : props.onStagePaths([entry.path])
                }
              >
                {mode === 'staged' ? '−' : '+'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )

  return (
    <>
      <div className="file-tree-bar">
        <span>
          变更 {props.entries.length}
          {props.truncated ? '（已截断）' : ''}
          {props.busyLabel ? ` · ${props.busyLabel}…` : ''}
        </span>
        <span className="git-bar-actions">
          {unstagedPaths.length > 0 && (
            <button
              className="ghost"
              disabled={props.busy}
              onClick={() => props.onStagePaths(unstagedPaths)}
            >
              全部暂存
            </button>
          )}
          {stagedPaths.length > 0 && (
            <button
              className="ghost"
              disabled={props.busy}
              onClick={() => props.onUnstagePaths(stagedPaths)}
            >
              全部取消
            </button>
          )}
          <button
            className="ghost"
            title="刷新变更列表"
            disabled={props.busy}
            onClick={props.onRefresh}
          >
            <RefreshIcon />
          </button>
        </span>
      </div>
      {props.entries.length === 0 ? (
        <div className="git-hint">工作树干净，没有未提交的变更。</div>
      ) : (
        <div className="git-groups">
          {staged.length > 0 && renderGroup('已暂存', staged, 'staged')}
          {unstaged.length > 0 && renderGroup('变更', unstaged, 'unstaged')}
        </div>
      )}
    </>
  )
}
