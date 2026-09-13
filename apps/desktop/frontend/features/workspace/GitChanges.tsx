import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitChangeEntry } from '@reflexion-os-studio/runtime-client'
import {
  gitBranchCreate,
  gitBranches,
  gitBranchSwitch,
  gitCommit,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../../api/workspace'
import { BranchPicker } from './BranchPicker'
import { GitChangeList } from './GitChangeList'
import { GitCommitBox } from './GitCommitBox'

type GitAction = 'commit' | 'push' | 'pull' | 'stage' | 'unstage' | 'branch'
type Busy = GitAction | 'refresh'

interface GitChangesProps {
  projectId: string
  systemReady: boolean
  /** 点击变更文件时直接交给右侧只读文件查看器。 */
  onOpenFile: (path: string) => void
  onOpenDiff?: (
    path: string,
    options: { staged?: boolean; oldPath?: string },
  ) => void
  /** 切分支/pull 前的脏 buffer 守卫（返回 false 中止）；必选注入，缺省不得放行。 */
  guardDirtyBuffersThen: () => Promise<boolean>
  /** checkout/pull 成功后强制重载全部文本标签；缺省跳过（Rust 侧凭陈旧 revision 拒绝覆盖，fail-safe）。 */
  reloadAllTextTabs?: () => void
  /** Git 面板每次完成刷新后的回调：文件树 git 徽章随变更联动刷新。 */
  onAfterMutation?: () => void
}

const BUSY_LABELS: Record<Busy, string> = {
  commit: '提交中',
  push: '推送中',
  pull: '拉取中',
  stage: '暂存中',
  unstage: '取消暂存中',
  branch: '分支操作中',
  refresh: '刷新中',
}

/** git 原始报错 → 中文引导文案（spec「错误处理」节）；未命中返回 null 走原文。 */
const GIT_ERROR_HINTS: Array<[RegExp, string]> = [
  [
    /non-fast-forward|fetch first|\[rejected\]/i,
    '远端有新提交，请先同步（↓更新）后再推送',
  ],
  [
    /nothing to commit|no changes added to commit/i,
    '没有已暂存的变更（nothing to commit）',
  ],
  [
    /would be overwritten|local changes/i,
    '本地未提交改动与目标分支冲突，请先提交或暂存',
  ],
  [
    /does not appear to be a git repository|no configured push/i,
    '未配置 origin 远端，请先在终端 git remote add',
  ],
]

function classifyGitError(message: string): string | null {
  for (const [pattern, friendly] of GIT_ERROR_HINTS) {
    if (pattern.test(message)) return friendly
  }
  return null
}

/** Git SCM 面板：分支芯片 + 提交框 + 暂存区分组列表（VS Code 布局）。 */
export function GitChanges(props: GitChangesProps): React.JSX.Element {
  const [repo, setRepo] = useState<boolean | null>(null)
  const [entries, setEntries] = useState<GitChangeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  const [ahead, setAhead] = useState<number | null>(null)
  const [behind, setBehind] = useState<number | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [message, setMessage] = useState('')
  // latest-ref：onAfterMutation 多为行内箭头（每次渲染新身份），不进任何依赖数组。
  const onAfterMutationRef = useRef(props.onAfterMutation)
  useEffect(() => {
    onAfterMutationRef.current = props.onAfterMutation
  }, [props.onAfterMutation])

  const loadStatus = useCallback(async (): Promise<void> => {
    const [status, branchList] = await Promise.all([
      gitStatus(props.projectId),
      gitBranches(props.projectId).catch(() => ({
        repo: false,
        current: null,
        branches: [] as string[],
      })),
    ])
    setRepo(status.repo)
    setEntries(status.entries)
    setTruncated(status.truncated)
    setBranch(status.branch)
    setAhead(status.ahead)
    setBehind(status.behind)
    setBranches(branchList.branches)
  }, [props.projectId])

  const refresh = useCallback(
    async (withFetch = false): Promise<void> => {
      if (!props.systemReady) return
      setLoading(true)
      setError(null)
      try {
        await loadStatus()
      } catch (error_) {
        setError(error_ instanceof Error ? error_.message : String(error_))
      } finally {
        setLoading(false)
        // 每次完成刷新（含失败）都通知宿主联动文件树徽章；身份经 latest-ref 读取。
        onAfterMutationRef.current?.()
      }
      // 静默 fetch 只由用户动作触发；fetch 后的二次刷新直接走 loadStatus，
      // 不再触发 fetch，杜绝循环。失败静默：ahead/behind 是尽力而为的指示器。
      if (withFetch) {
        void gitFetch(props.projectId)
          .then(() => loadStatus())
          .catch(() => {})
      }
    },
    [props.projectId, props.systemReady, loadStatus],
  )

  useEffect(() => {
    setRepo(null)
    setEntries([])
    setBranch(null)
    setAhead(null)
    setBehind(null)
    setBranches([])
    setLoading(true)
    setError(null)
    void refresh(true)
  }, [props.projectId, props.systemReady, refresh])

  const { guardDirtyBuffersThen, reloadAllTextTabs } = props

  const runAction = useCallback(
    async (
      kind: Busy,
      action: () => Promise<unknown>,
      options: { guard?: boolean; reloadTabs?: boolean } = {},
    ): Promise<boolean> => {
      setBusy(kind)
      setError(null)
      let attempted = false
      let succeeded = false
      try {
        if (options.guard) {
          const proceed = await guardDirtyBuffersThen()
          if (!proceed) return false
        }
        attempted = true
        await action()
        succeeded = true
        if (options.reloadTabs) reloadAllTextTabs?.()
        return true
      } catch (error_) {
        setError(error_ instanceof Error ? error_.message : String(error_))
        return false
      } finally {
        // 复合动作（如提交并推送）部分失败时状态已变：成败都要重载
        // status+branches，面板不留陈旧视图；静默 fetch 只在成功时触发。
        if (attempted) await refresh(succeeded)
        setBusy(null)
      }
    },
    [guardDirtyBuffersThen, reloadAllTextTabs, refresh],
  )

  const canCommit =
    message.trim() !== '' && entries.some((entry) => entry.staged)

  const runPaths = (kind: GitAction, paths: string[]): void => {
    if (paths.length === 0) return
    void runAction(kind, () =>
      kind === 'stage'
        ? gitStage(props.projectId, paths)
        : gitUnstage(props.projectId, paths),
    )
  }

  const runCommit = (andPush: boolean): void => {
    if (!canCommit) return
    void runAction('commit', async () => {
      await gitCommit(props.projectId, message.trim())
      setMessage('')
      if (andPush) await gitPush(props.projectId)
    })
  }

  const runActionWith =
    (
      kind: Busy,
      action: () => Promise<unknown>,
      options?: { guard?: boolean; reloadTabs?: boolean },
    ) =>
    () => {
      void runAction(kind, action, options)
    }

  const switchBranch = (name: string): void => {
    if (name === branch) return
    void runAction('branch', () => gitBranchSwitch(props.projectId, name), {
      guard: true,
      reloadTabs: true,
    })
  }

  const createBranch = (name: string, checkout: boolean): void => {
    void runAction(
      'branch',
      () => gitBranchCreate(props.projectId, name, checkout),
      { guard: checkout, reloadTabs: checkout },
    )
  }

  const openEntry = (entry: GitChangeEntry): void => {
    if (props.onOpenDiff !== undefined) {
      props.onOpenDiff(entry.path, {
        staged: entry.staged,
        oldPath: entry.oldPath,
      })
      return
    }
    props.onOpenFile(entry.path)
  }

  // runAction 成败都会刷新（成功含静默 fetch）；纯刷新动作以空 action 表达。
  const busyRefresh = runActionWith('refresh', async () => {})

  const retryButton = (
    <button className="ghost" onClick={busyRefresh}>
      重试
    </button>
  )

  // 已知 git 报错给中文引导主行 + 原文小字详情；未识别时原样展示。
  const errorBanner = (text: string): React.JSX.Element => {
    const friendly = classifyGitError(text)
    return (
      <div className="git-hint git-hint-error">
        <strong>{friendly ?? text}</strong>
        {friendly !== null && <div className="git-error-detail">{text}</div>}
        {retryButton}
      </div>
    )
  }

  if (!props.systemReady) {
    return (
      <div className="git-hint">工具 Runtime 不可用，Git 变更暂不可用。</div>
    )
  }
  if (loading && repo === null) {
    return <div className="git-hint">加载中…</div>
  }
  if (repo === null && error !== null) {
    return errorBanner(error)
  }
  if (repo === false) {
    return (
      <div className="git-hint">当前工作区不是 Git 仓库（未找到 .git）。</div>
    )
  }

  return (
    <div className="git-changes">
      <div className="git-changes-head">
        <BranchPicker
          branch={branch}
          ahead={ahead}
          behind={behind}
          branches={branches}
          busy={busy !== null}
          onSwitch={switchBranch}
          onCreate={createBranch}
          onRefresh={() => void refresh()}
        />
        <div className="git-head-actions">
          <button
            className="ghost"
            disabled={busy !== null}
            title="拉取并合并远端更新"
            onClick={runActionWith('pull', () => gitPull(props.projectId), {
              guard: true,
              reloadTabs: true,
            })}
          >
            ↓ 更新
          </button>
          <button
            className="ghost"
            disabled={busy !== null}
            title="推送本地提交到远端"
            onClick={runActionWith('push', () => gitPush(props.projectId))}
          >
            ↑ 推送
          </button>
        </div>
      </div>
      <GitCommitBox
        message={message}
        canCommit={canCommit}
        busy={busy !== null}
        onMessage={setMessage}
        onCommit={runCommit}
      />
      {error !== null && errorBanner(error)}
      <GitChangeList
        entries={entries}
        truncated={truncated}
        busy={busy !== null}
        busyLabel={busy === null ? null : BUSY_LABELS[busy]}
        onOpen={openEntry}
        onStagePaths={(paths) => runPaths('stage', paths)}
        onUnstagePaths={(paths) => runPaths('unstage', paths)}
        onRefresh={busyRefresh}
      />
    </div>
  )
}
