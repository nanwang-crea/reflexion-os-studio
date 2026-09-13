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
  gitRemoteAdd,
  gitRemotes,
  gitRemoteRemove,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitRemote,
} from '../../api/workspace'
import { classifyGitError } from '../../lib/git-errors'
import { BranchPicker } from './BranchPicker'
import { GitChangeList } from './GitChangeList'
import { GitCommitBox } from './GitCommitBox'
import type { OpenDiffHandler } from './types'

type GitAction = 'commit' | 'push' | 'pull' | 'stage' | 'unstage' | 'branch'
type Busy = GitAction | 'refresh'

interface GitChangesProps {
  projectId: string
  systemReady: boolean
  /** 点击变更文件时直接交给右侧只读文件查看器。 */
  onOpenFile: (path: string) => void
  onOpenDiff?: OpenDiffHandler
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

/** Git SCM 面板：分支芯片 + 提交框 + 暂存区分组列表（VS Code 布局）。 */
export function GitChanges(props: GitChangesProps): React.JSX.Element {
  const [repo, setRepo] = useState<boolean | null>(null)
  const [entries, setEntries] = useState<GitChangeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  const [ahead, setAhead] = useState<number | null>(null)
  const [behind, setBehind] = useState<number | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
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
    const [status, branchList, remoteList] = await Promise.all([
      gitStatus(props.projectId),
      gitBranches(props.projectId).catch(() => ({
        repo: false,
        current: null,
        branches: [] as string[],
        remoteBranches: [] as string[],
      })),
      gitRemotes(props.projectId).catch(() => ({
        repo: false,
        remotes: [] as GitRemote[],
      })),
    ])
    setRepo(status.repo)
    setEntries(status.entries)
    setTruncated(status.truncated)
    setBranch(status.branch)
    setAhead(status.ahead)
    setBehind(status.behind)
    setBranches(branchList.branches)
    setRemoteBranches(branchList.remoteBranches)
    setRemotes(remoteList.remotes)
  }, [props.projectId])

  // 远端增删只动本地 config/refs：branches（remote remove 会删 refs/remotes/*）+
  // remotes 轻量重载即可；工作树与 status 不变，不走全量 refresh、不联动徽章。
  const refreshRefs = useCallback(async (): Promise<void> => {
    const [branchList, remoteList] = await Promise.all([
      gitBranches(props.projectId).catch(() => null),
      gitRemotes(props.projectId).catch(() => null),
    ])
    if (branchList !== null) {
      setBranches(branchList.branches)
      setRemoteBranches(branchList.remoteBranches)
    }
    if (remoteList !== null) setRemotes(remoteList.remotes)
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
    setRemoteBranches([])
    setRemotes([])
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

  const createBranch = (
    name: string,
    checkout: boolean,
    startRef?: string,
  ): void => {
    void runAction(
      'branch',
      () => gitBranchCreate(props.projectId, name, checkout, startRef),
      { guard: checkout, reloadTabs: checkout },
    )
  }

  // 远端增删走轻量路径（refreshRefs）：不触碰工作树，故跳过脏 buffer 守卫、
  // 标签重载、onAfterMutation 联动与静默 fetch；成败回传供 picker 清表单。
  const runRemote = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy('branch')
      setError(null)
      try {
        await action()
        await refreshRefs()
        return true
      } catch (error_) {
        setError(error_ instanceof Error ? error_.message : String(error_))
        return false
      } finally {
        setBusy(null)
      }
    },
    [refreshRefs],
  )

  const addRemote = (name: string, url: string): Promise<boolean> =>
    runRemote(() => gitRemoteAdd(props.projectId, name, url))

  const removeRemote = (name: string): Promise<boolean> =>
    runRemote(() => gitRemoteRemove(props.projectId, name))

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
          remoteBranches={remoteBranches}
          remotes={remotes}
          busy={busy !== null}
          onSwitch={switchBranch}
          onCreate={createBranch}
          onRemoteAdd={addRemote}
          onRemoteRemove={removeRemote}
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
