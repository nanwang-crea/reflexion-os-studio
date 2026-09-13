import { useCallback, useEffect, useRef, useState } from 'react'
import { errorInfoOf, type GitErrorInfo } from '../../lib/git-errors'
import {
  gitBranchCreate,
  gitBranchSwitch,
  gitCommitDiff,
  gitCommitFiles,
  gitLog,
  type GitCommitFile,
  type GitLogEntry,
} from '../../api/workspace'
import { RefreshIcon } from '../../ui/icons'
import { showToast } from '../../components/Toast'
import { GitHistoryRow } from './GitHistoryRow'
import type { OpenDiffHandler } from './types'

type BusyAction = 'branch' | 'checkout' | 'more'

interface GitHistoryProps {
  projectId: string
  systemReady: boolean
  /** 点开 commit 文件时把两侧内容交给右侧只读 Diff（source:'chat' 通道）。 */
  onOpenDiff?: OpenDiffHandler
  /** 检出/切换前的脏 buffer 守卫（返回 false 中止）；必选注入，缺省不得放行。 */
  guardDirtyBuffersThen: () => Promise<boolean>
  /** checkout 成功后强制重载全部文本标签；缺省跳过（Rust 侧凭陈旧 revision 拒绝覆盖，fail-safe）。 */
  reloadAllTextTabs?: () => void
  /** 历史面板每次完成刷新后的回调：文件树 git 徽章随工作树联动刷新。 */
  onAfterMutation?: () => void
}

const PAGE_SIZE = 50

const BUSY_LABELS: Record<BusyAction, string> = {
  branch: '建分支中',
  checkout: '切换中',
  more: '加载中',
}

/** 提交历史面板：HEAD 反向时间序分页浏览 + commit 文件展开 diff + 导航（建分支/检出）。 */
export function GitHistory(props: GitHistoryProps): React.JSX.Element {
  const [repo, setRepo] = useState<boolean | null>(null)
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [error, setError] = useState<GitErrorInfo | null>(null)
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const [filesByHash, setFilesByHash] = useState<
    Record<string, GitCommitFile[]>
  >({})
  const [menuOpenHash, setMenuOpenHash] = useState<string | null>(null)
  const [formHash, setFormHash] = useState<string | null>(null)
  // latest-ref：onAfterMutation 多为行内箭头（每次渲染新身份），不进任何依赖数组。
  const onAfterMutationRef = useRef(props.onAfterMutation)
  useEffect(() => {
    onAfterMutationRef.current = props.onAfterMutation
  }, [props.onAfterMutation])

  const refresh = useCallback(async (): Promise<void> => {
    if (!props.systemReady) return
    setLoading(true)
    setError(null)
    try {
      const result = await gitLog(props.projectId, {
        skip: 0,
        limit: PAGE_SIZE,
      })
      setRepo(result.repo)
      setCommits(result.commits)
      setHasMore(result.hasMore)
    } catch (error_) {
      setError(errorInfoOf(error_))
    } finally {
      setLoading(false)
      // 每次完成刷新（含失败）都通知宿主联动文件树徽章；身份经 latest-ref 读取。
      onAfterMutationRef.current?.()
    }
  }, [props.projectId, props.systemReady])

  useEffect(() => {
    setRepo(null)
    setExpandedHash(null)
    setFilesByHash({})
    setMenuOpenHash(null)
    setFormHash(null)
    void refresh()
  }, [props.projectId, props.systemReady, refresh])

  const { guardDirtyBuffersThen, reloadAllTextTabs } = props

  const runAction = useCallback(
    async (
      kind: BusyAction,
      action: () => Promise<unknown>,
      options: { guard?: boolean; reloadTabs?: boolean } = {},
    ): Promise<boolean> => {
      setBusy(kind)
      setError(null)
      try {
        if (options.guard) {
          const proceed = await guardDirtyBuffersThen()
          if (!proceed) return false
        }
        await action()
        if (options.reloadTabs) reloadAllTextTabs?.()
        return true
      } catch (error_) {
        setError(errorInfoOf(error_))
        return false
      } finally {
        setBusy(null)
      }
    },
    [guardDirtyBuffersThen, reloadAllTextTabs],
  )

  /** 导航成功后的统一收尾：提示 + 关菜单/表单 + 重载 log（内部联动徽章刷新）。 */
  const afterNavigate = async (message: string): Promise<void> => {
    showToast(message, 'success')
    setMenuOpenHash(null)
    setFormHash(null)
    await refresh()
  }

  const loadMore = useCallback(async (): Promise<void> => {
    setBusy('more')
    setError(null)
    try {
      const result = await gitLog(props.projectId, {
        skip: commits.length,
        limit: PAGE_SIZE,
      })
      setRepo(result.repo)
      setCommits((prev) => [...prev, ...result.commits])
      setHasMore(result.hasMore)
    } catch (error_) {
      setError(errorInfoOf(error_))
    } finally {
      setBusy(null)
    }
  }, [props.projectId, commits.length])

  const toggleRow = (hash: string): void => {
    if (expandedHash === hash) {
      setExpandedHash(null)
      return
    }
    setExpandedHash(hash)
    if (filesByHash[hash] === undefined) {
      void gitCommitFiles(props.projectId, hash)
        .then((result) =>
          setFilesByHash((prev) => ({ ...prev, [hash]: result.files })),
        )
        .catch((error_: unknown) => setError(errorInfoOf(error_)))
    }
  }

  const openCommitFile = (hash: string, file: GitCommitFile): void => {
    if (props.onOpenDiff === undefined) return
    const openDiff = props.onOpenDiff
    void gitCommitDiff(props.projectId, hash, file.path)
      .then((diff) =>
        openDiff(file.path, {
          source: 'chat',
          before: diff.original,
          after: diff.modified,
          binary: diff.binary,
          truncated: diff.truncated,
          label: '历史对比（commit ↔ 父提交）',
        }),
      )
      .catch((error_: unknown) => setError(errorInfoOf(error_)))
  }

  // 行组件的菜单外点 effect 依赖此回调，必须 useCallback 恒定身份。
  const closeMenu = useCallback(() => setMenuOpenHash(null), [])

  const createBranch = (
    hash: string,
    name: string,
    checkout: boolean,
  ): void => {
    void runAction(
      'branch',
      () => gitBranchCreate(props.projectId, name, checkout, hash),
      { guard: checkout, reloadTabs: checkout },
    ).then(async (ok) => {
      if (ok) await afterNavigate(`已基于 ${hash.slice(0, 7)} 创建分支 ${name}`)
    })
  }

  const checkoutCommit = (hash: string): void => {
    void runAction('checkout', () => gitBranchSwitch(props.projectId, hash), {
      guard: true,
      reloadTabs: true,
    }).then(async (ok) => {
      if (ok) await afterNavigate(`已切换到提交 ${hash.slice(0, 7)}`)
    })
  }

  const errorBanner = (info: GitErrorInfo): React.JSX.Element => (
    <div className="git-hint git-hint-error">
      <strong>{info.message}</strong>
      {info.detail !== null && (
        <div className="git-error-detail">{info.detail}</div>
      )}
      <button className="ghost" onClick={() => void refresh()}>
        重试
      </button>
    </div>
  )

  if (!props.systemReady) {
    return (
      <div className="git-hint">工具 Runtime 不可用，提交历史暂不可用。</div>
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
    <div className="git-changes git-history">
      <div className="file-tree-bar">
        <span>
          提交 {commits.length}
          {busy !== null && busy !== 'more' ? ` · ${BUSY_LABELS[busy]}…` : ''}
        </span>
        <span className="git-bar-actions">
          <button
            className="ghost"
            title="刷新提交历史"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </button>
        </span>
      </div>
      {error !== null && errorBanner(error)}
      {commits.length === 0 && !loading ? (
        <div className="git-hint">该仓库还没有任何提交。</div>
      ) : (
        <ul className="git-hist-list">
          {commits.map((commit) => (
            <GitHistoryRow
              key={commit.hash}
              commit={commit}
              busy={busy !== null}
              menuOpen={menuOpenHash === commit.hash}
              expanded={expandedHash === commit.hash}
              files={filesByHash[commit.hash]}
              formOpen={formHash === commit.hash}
              onToggle={toggleRow}
              onMenuToggle={(hash) =>
                setMenuOpenHash(menuOpenHash === hash ? null : hash)
              }
              onMenuClose={closeMenu}
              onOpenForm={(hash) => {
                setMenuOpenHash(null)
                setFormHash(formHash === hash ? null : hash)
              }}
              onCheckout={checkoutCommit}
              onBranchCreate={createBranch}
              onOpenFile={openCommitFile}
            />
          ))}
        </ul>
      )}
      {hasMore && (
        <button
          type="button"
          className="ghost git-hist-more"
          disabled={busy !== null}
          onClick={() => void loadMore()}
        >
          {busy === 'more' ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}
